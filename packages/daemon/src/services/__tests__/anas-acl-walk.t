#!/usr/bin/perl
#
# Unit tests for services/anas-acl-walk.pl (cr3.shares, fourth and fifth
# reviews). ANAS_ACL_WALK_HELPER runs them against another copy (the red
# runs of the fifth review used the round-4 helper).
# Run by services/__tests__/access-acl-walk.test.ts (`prove` on this file),
# or by hand:  prove packages/daemon/src/services/__tests__/anas-acl-walk.t
#
# The tools are a recording stand-in: for every operand it prints which tool
# ran and what the operand (/proc/self/fd/N) resolves to IN THE TOOL'S OWN
# PROCESS — the inode the helper pinned, by its path — so each test reads
# exactly what the walk acted on. Device numbers are simulated through the
# helper's io seam (a nested btrfs subvolume, a swap).
#
use strict;
use warnings;
no warnings 'once';

use Cwd qw(abs_path);
use Fcntl qw(O_RDONLY O_DIRECTORY F_SETFD);
use File::Basename qw(dirname);
use File::Path qw(make_path remove_tree);
use File::Temp qw(tempdir);
use JSON::PP ();
use POSIX ();
use Scalar::Util ();
use Test::More;

my $HELPER = $ENV{ANAS_ACL_WALK_HELPER} // abs_path(dirname(__FILE__) . '/../anas-acl-walk.pl');
require $HELPER;

my $tmp = tempdir('anas-acl-walk-XXXXXX', TMPDIR => 1, CLEANUP => 1);

# The recording tool: logs "<tool> <first option> <resolved operand>" per operand.
my $tool = "$tmp/tool";
open(my $t, '>', $tool) or die;
print $t <<'SH';
#!/bin/sh
name=$(basename "$0"); first="$1"; seen=0; rc=0
for a in "$@"; do
  if [ "$seen" = 1 ]; then
    real=$(readlink "$a")
    if [ -n "$FAKE_FAIL" ] && [ "${real##*/}" = "$FAKE_FAIL" ]; then
      echo "$name: $a: Operation not permitted" >&2; rc=1
    elif [ -n "$FAKE_SILENT_FAIL" ]; then
      rc=1
    elif [ -n "$FAKE_BATCH_FAIL" ] && [ "$#" -gt 5 ] && [ "$name" = setfacl ]; then
      rc=1
    else
      printf '%s %s %s\n' "$name" "$first" "$real" >> "$FAKE_LOG"
    fi
  fi
  [ "$a" = "--" ] && seen=1
done
exit $rc
SH
close $t;
chmod 0755, $tool;
for my $n (qw(chown chmod setfacl)) {
    symlink($tool, "$tmp/$n") or die;
}
my %TOOLS = (chown => "$tmp/chown", chmod => "$tmp/chmod", setfacl => "$tmp/setfacl");

# A tree: r/{f1, a/{f2, b/{f3}}, link -> f1, fifo, sub/{f4}}.
sub tree {
    my ($name) = @_;
    my $r = "$tmp/$name";
    make_path("$r/a/b", "$r/sub");
    for my $f ("$r/f1", "$r/a/f2", "$r/a/b/f3", "$r/sub/f4") {
        open(my $h, '>', $f) or die;
        close $h;
    }
    symlink('f1', "$r/link") or die;
    POSIX::mkfifo("$r/fifo", 0600) or die;
    return $r;
}

# Open a root the way the daemon hands it over: a directory descriptor that
# survives exec (the tools reach it as /proc/self/fd/N).
sub root_of {
    my ($path, %o) = @_;
    sysopen(my $h, $path, O_RDONLY | O_DIRECTORY) or die "$path: $!";
    fcntl($h, F_SETFD, 0) or die;
    my @s = stat($h);
    return ($h, { fd => fileno($h), path => $path, dev => $o{dev} // $s[0], ino => $s[1], %{ $o{extra} // {} } });
}

sub job {
    my (%o) = @_;
    return { roots => $o{roots}, tools => \%TOOLS, acl => 'u::rwX,m::rwX', %{ $o{ops} // {} } };
}

sub logged {
    my ($log) = @_;
    open(my $h, '<', $log) or return [];
    my @lines = map { chomp; $_ } <$h>;
    close $h;
    return [sort @lines];
}

sub walk {
    my ($job, $log) = @_;
    unlink $log;
    local $ENV{FAKE_LOG} = $log;
    my ($code, $out) = AnasAclWalk::run(JSON::PP->new->encode($job));
    return ($code, $out, logged($log));
}

# --- what the walk reaches -----------------------------------------------------
{
    my $r = tree('plain');
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/plain.log");
    is($code, 0, 'a walk that completes exits 0');
    is_deeply($log, [sort map { "setfacl -b $r$_" } ('', '/f1', '/a', '/a/f2', '/a/b', '/a/b/f3', '/sub', '/sub/f4')],
        'the access ACL reaches the root, every regular file and every directory — through each pinned descriptor');
    is($out->{skipped}{links}, 1, 'the link is counted, never acted on');
    is($out->{skipped}{other}, 1, 'the FIFO is counted, never acted on');
    is_deeply($out->{visited}, { files => 4, dirs => 4 }, 'visited counts');
    is($out->{changed}{acl}, 8, 'changed counts every operand the tool did not refuse');
}

# --- every step, in order, on the right members ---------------------------------
{
    my $r = tree('steps');
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root], ops => { chown => '1:2', defaultAcl => 'u::rwx', setgid => JSON::PP::true, clear => JSON::PP::true, mode => 'u=rwX' }), "$tmp/steps.log");
    is($code, 0);
    my %by = ();
    $by{ join ' ', (split / /)[0, 1] }++ for @$log;
    is_deeply(\%by, { 'chown 1:2' => 8, 'setfacl -b' => 16, 'setfacl -d' => 4, 'chmod g+s' => 4, 'chmod u=rwX' => 8 },
        'chown, access ACL, clear and mode reach files and directories; default ACL and setgid directories only');
}

# --- the device boundary, and a nested root (a btrfs subvolume, simulated) -----
{
    my $r = tree('btrfs');
    my $sub_ino = (stat("$r/sub"))[1];
    my $f4_ino = (stat("$r/sub/f4"))[1];
    my %other = map { $_ => 1 } ($sub_ino, $f4_ino);
    my $real_dev = (stat($r))[0];
    my $fake = $real_dev + 7;
    my $remap = sub { my ($s) = @_; return $s unless $s; $s->[0] = $fake if $other{ $s->[1] }; return $s };
    local $AnasAclWalk::io{lstat} = do { my $o = $AnasAclWalk::io{lstat}; sub { $remap->($o->(@_)) } };
    local $AnasAclWalk::io{fstat} = do { my $o = $AnasAclWalk::io{fstat}; sub { $remap->($o->(@_)) } };

    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/btrfs1.log");
    is($code, 0);
    ok(!grep({ m{/sub} } @$log), 'a directory on another device is never touched or entered (its top included)');
    is($out->{boundary}, 1, 'and is counted as a boundary');
    is_deeply([map { [$_->{name}, $_->{dev}] } @{ $out->{boundaries} }], [['sub', $fake]], 'with its path and device, for the daemon');

    my ($h2, $nested) = root_of("$r/sub", dev => $fake);
    ($code, $out, $log) = walk(job(roots => [$root, $nested]), "$tmp/btrfs2.log");
    is($code, 0);
    is($out->{boundary}, 0, 'a nested root the plan names is not a boundary');
    is($out->{nestedRoots}, 1, 'it is counted as a nested root');
    is_deeply([grep { m{/sub} } @$log], ["setfacl -b $r/sub", "setfacl -b $r/sub/f4"], 'and is walked as a root of its own');
}

# --- a swap between lstat and fstat --------------------------------------------
{
    my $r = tree('swap');
    my $f2_ino = (stat("$r/a/f2"))[1];
    local $AnasAclWalk::io{fstat} = do {
        my $o = $AnasAclWalk::io{fstat};
        sub { my $s = $o->(@_); $s->[1] += 1000000 if $s && $s->[1] == $f2_ino; return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/swap.log");
    is($code, 0, 'a swapped entry does not stop the walk');
    is($out->{swapped}, 1, 'it is counted');
    ok(!grep({ m{/a/f2$} } @$log), 'and never acted on');
    ok(grep({ m{/a/b/f3$} } @$log), 'the rest of the tree is still walked');
}

# --- .zfs at the top of a ZFS root ----------------------------------------------
{
    my $r = tree('zfs');
    make_path("$r/.zfs/snapshot", "$r/a/.zfs");
    my ($h, $root) = root_of($r, extra => { zfs => JSON::PP::true });
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/zfs.log");
    is($out->{zfsControl}, 1, '.zfs at the top of a ZFS root is skipped');
    ok(!grep({ m{$r/\.zfs} } @$log), 'never touched');
    ok(grep({ m{$r/a/\.zfs$} } @$log), 'a .zfs deeper down is ordinary data');
}

# --- depth bound ----------------------------------------------------------------
{
    my $r = tree('deep');
    my ($h, $root) = root_of($r);
    AnasAclWalk::check_roots([$root]);
    my $st = AnasAclWalk::new_state(job(roots => [$root]), 1);
    local $ENV{FAKE_LOG} = "$tmp/deep.log";
    unlink "$tmp/deep.log";
    AnasAclWalk::walk_root($st, $root, {});
    AnasAclWalk::flush($st);
    my $log = logged("$tmp/deep.log");
    is($st->{tooDeep}, 1, 'a directory below the depth bound is counted');
    ok(grep({ m{$r/a/b$} } @$log), 'it is still acted on itself');
    ok(!grep({ m{$r/a/b/f3$} } @$log), 'but not entered');
}

# --- tool failures --------------------------------------------------------------
{
    my $r = tree('fail');
    my ($h, $root) = root_of($r);
    local $ENV{FAKE_FAIL} = 'f2';
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/fail.log");
    is($code, 0, 'a refused operand does not stop the walk');
    is($out->{errors}, 1, 'it is counted');
    is($out->{changed}{acl}, 7, 'and is not claimed as changed');
    my ($n) = grep { $_->{kind} eq 'error' } @{ $out->{notes} };
    is_deeply([$n->{op}, $n->{name}, $n->{ino}], ['acl', 'a/f2', (stat("$r/a/f2"))[1]], 'the note names the step, the path and the inode');
}
{
    # Fifth review D3: a tool that fails without naming its operands — every
    # entry is run again on its own, and each ends changed or reported.
    my $r = tree('silent');
    my ($h, $root) = root_of($r);
    local $ENV{FAKE_SILENT_FAIL} = 1;
    my ($code, $out) = walk(job(roots => [$root]), "$tmp/silent.log");
    is($out->{changed}{acl}, 0, 'a failure the tool did not attribute claims nothing of its batch');
    is($out->{failed}{acl}, 8, 'every entry it failed on is counted, one by one (was: ONE error for the batch)');
    is($out->{errors}, 8, 'and the errors add up');
    ok($out->{accounted}, 'changed + failed = the entries the step applies to');
}
{
    my $r = tree('batchfail');
    my ($h, $root) = root_of($r);
    local $ENV{FAKE_BATCH_FAIL} = 1;
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/batchfail.log");
    is($out->{changed}{acl}, 8, 'a batch that fails as a whole but succeeds one by one: every entry changed');
    is($out->{errors}, 0, 'nothing reported');
    is(scalar(@$log), 8, 'each entry reached once, on its own');
}

# --- refusals before anything --------------------------------------------------
{
    my $r = tree('refuse');
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [{ %$root, ino => $root->{ino} + 1 }]), "$tmp/refuse.log");
    is($code, 2, 'a root that is not the planned directory refuses');
    is_deeply($log, [], 'with nothing done');
    ($code, $out) = AnasAclWalk::run('{"roots":[]}');
    is($code, 2, 'a job without roots refuses');
    ($code, $out) = walk({ %{ job(roots => [$root]) }, acl => '-x' }, "$tmp/refuse.log");
    is($code, 2, 'a spec that reads as an option refuses');
    ($code, $out) = walk({ %{ job(roots => [$root]) }, tools => { %TOOLS, chmod => 'chmod' } }, "$tmp/refuse.log");
    is($code, 2, 'a tool that is not an absolute path refuses');
    ($code, $out) = walk({ roots => [$root], tools => \%TOOLS }, "$tmp/refuse.log");
    is($code, 2, 'a job that changes nothing refuses');
}

# --- fifth review D2: the boundary is the MOUNT (a same-device bind, simulated) -
{
    my $r = tree('bind');
    my $sub_ino = (stat("$r/sub"))[1];
    my $f4_ino = (stat("$r/sub/f4"))[1];
    # `sub` and what is in it sit on another mount of the SAME device (a bind
    # mount): only the mount id tells them apart.
    my $root_fd;
    local $AnasAclWalk::io{mnt} = do {
        my $o = $AnasAclWalk::io{mnt};
        sub {
            my ($fd) = @_;
            my $m = $o->($fd);
            my @st = stat("/proc/self/fd/$fd");
            return defined $m && @st && ($st[1] == $sub_ino || $st[1] == $f4_ino) ? $m + 1000 : $m;
        }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/bind.log");
    is($code, 0);
    ok(!grep({ m{/sub} } @$log), 'a same-device directory on another MOUNT is never touched or entered, its top included');
    is($out->{boundary}, 1, 'it is a boundary');
    my ($b) = @{ $out->{boundaries} };
    is_deeply([$b->{name}, $b->{dev}, $b->{ino}], ['sub', (stat($r))[0], $sub_ino], 'reported with its path, device and inode');
    ok(defined $b->{mnt} && $b->{mnt} >= 1000, 'and its mount id');
    ok($out->{accounted}, 'the counts add up');

    my ($h2, $nested) = root_of("$r/sub");
    ($code, $out, $log) = walk(job(roots => [$root, $nested]), "$tmp/bind2.log");
    is($out->{nestedRoots}, 1, 'named as a root of the walk, it is a nested root (matched by device, inode AND mount)');
    is_deeply([grep { m{/sub} } @$log], ["setfacl -b $r/sub", "setfacl -b $r/sub/f4"], 'walked from its own descriptor, on its own mount');
}
{
    my $r = tree('nomnt');
    my $f1_ino = (stat("$r/f1"))[1];
    my ($h, $root) = root_of($r);
    {
        local $AnasAclWalk::io{mnt} = sub { return undef };
        my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/nomnt.log");
        is($code, 2, 'a root whose mount cannot be read: the walk refuses to start (never a walk by device only)');
        like($out->{refused}, qr/mount of the walk root .* could not be read/, 'and says why');
        is_deeply($log, [], 'nothing done');
    }
    {
        local $AnasAclWalk::io{mnt} = do {
            my $o = $AnasAclWalk::io{mnt};
            sub { my @st = stat("/proc/self/fd/$_[0]"); return @st && $st[1] == $f1_ino ? undef : $o->(@_) }
        };
        my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/nomnt2.log");
        ok(!grep({ m{/f1$} } @$log), 'an entry whose mount cannot be read is not touched');
        is($out->{errors}, 1, 'it is an error');
        ok($out->{accounted});
    }
}

# --- fifth review D4: names never grow the report --------------------------------
{
    my $long = 'x' x 300;
    my $p = AnasAclWalk::short_path([{ name => undef }, { name => 'a' x 200 }, { name => 'b' x 200 }], 'c' x 200);
    ok(length($p) <= AnasAclWalk::NAME_KEPT() + 40, 'a long path is cut to its head and tail');
    like($p, qr/^a{64}\[\.\.\.602 bytes\.\.\.\]c{64}$/, 'and says how long it was');
    is(AnasAclWalk::short_path([{ name => undef }, { name => 'd' }], 'f'), 'd/f', 'a short path is kept whole');
    my $out = { notes => [map { { kind => 'error', name => "\x01" x 160, message => 'm' x 300 } } 1 .. 50], boundaries => [map { { name => "\x01" x 160 } } 1 .. 200], notesDropped => 0, boundariesDropped => 0 };
    local $AnasAclWalk::REPORT_MAX = 20000;
    my $text = AnasAclWalk::encode_report($out);
    ok(length($text) <= 20000, 'the report is held under its bound');
    ok($out->{notesDropped} > 0 || $out->{boundariesDropped} > 0, 'and says how much it dropped');
}
{
    # 60 levels of 250-byte names of control characters, walked 40 deep.
    my $r = "$tmp/longnames";
    make_path($r);
    my $n = "\x01" x 250;
    chdir $r or die;
    for (1 .. 60) {
        mkdir $n or die "mkdir: $!";
        chdir $n or die;
    }
    chdir $tmp or die;
    my ($h, $root) = root_of($r);
    AnasAclWalk::check_roots([$root]);
    my $st = AnasAclWalk::new_state(job(roots => [$root]), 40);
    local $ENV{FAKE_LOG} = "$tmp/longnames.log";
    AnasAclWalk::walk_root($st, $root, {});
    AnasAclWalk::flush($st);
    my ($tn) = grep { $_->{kind} eq 'tooDeep' } @{ $st->{notes} };
    ok($tn && length($tn->{name}) <= AnasAclWalk::NAME_KEPT() + 40, 'a note 40 levels of 250-byte names deep carries a bounded path');
    like($tn->{name}, qr/\[\.\.\.\d+ bytes\.\.\.\]/, 'and its length');
    my $json = AnasAclWalk::encode_report(AnasAclWalk::result($st, done => JSON::PP::true));
    ok(length($json) < 100000, 'the whole report stays small (' . length($json) . ' bytes)');
}
{
    my $r = tree('manyswaps');
    make_path("$r/many");
    for my $i (1 .. 80) { open(my $f, '>', "$r/many/s$i") or die; close $f }
    local $AnasAclWalk::io{fstat} = do {
        my $o = $AnasAclWalk::io{fstat};
        sub { my $s = $o->(@_); return $s unless $s && S_ISREG_of($s); $s->[1] += 1000000; return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out) = walk(job(roots => [$root]), "$tmp/manyswaps.log");
    is(scalar @{ $out->{notes} }, AnasAclWalk::NOTES_KEPT(), 'notes are capped');
    is($out->{notesDropped}, $out->{swapped} - AnasAclWalk::NOTES_KEPT(), 'and the rest are counted, not lost');
    ok($out->{accounted});
}
sub S_ISREG_of { return (($_[0][2] & 0170000) == 0100000) }

# --- fifth review D5: the descriptor limit is read, and a low one degrades -------
{
    my $limits = "$tmp/limits";
    open(my $f, '>', $limits) or die;
    print $f "Limit                     Soft Limit           Hard Limit           Units     \n";
    print $f "Max cpu time              unlimited            unlimited            seconds   \n";
    print $f "Max open files            64                   524288               files     \n";
    close $f;
    my @b = do { local $/; AnasAclWalk::depth_budget(1, $limits) };
    is_deeply([@b[1, 2]], [8, 64], 'the limit is read line by line even when the caller slurps ($/ undef): batch 8 for 64 descriptors');
    is($b[0], 64 - 8 - AnasAclWalk::FD_RESERVE() - 1, 'and the depth is what is left');
    my @d = AnasAclWalk::depth_budget(1, "$tmp/no-such-limits");
    is($d[2], 1024, 'an unreadable limits file assumes 1024');
}
{
    # The real thing under `ulimit -n 48`: a 70-deep tree degrades to "too
    # deep" with a count, never to a stream of "Too many open files".
    my $r = "$tmp/lowlimit";
    my $d = $r;
    make_path($r);
    for (1 .. 70) { $d .= '/d'; mkdir $d or die }
    open(my $f, '>', "$d/leaf") or die; close $f;
    my @s = stat($r);
    my $job = JSON::PP->new->encode({ roots => [{ fd => 3, path => $r, dev => $s[0] + 0, ino => $s[1] + 0 }], tools => \%TOOLS, mode => 'u=rwX' });
    open(my $jf, '>', "$tmp/lowlimit.json") or die; print $jf $job; close $jf;
    local $ENV{FAKE_LOG} = "$tmp/lowlimit.log";
    my $line = `sh -c 'ulimit -n 48 && exec perl "\$1" < "\$2" 3< "\$3"' sh '$HELPER' '$tmp/lowlimit.json' '$r'`;
    my $rc = $? >> 8;
    my $rep = eval { JSON::PP->new->decode($line) } // {};
    is($rc, 0, 'under a low descriptor limit the walk completes');
    ok($rep->{tooDeep} >= 1, "it stops entering at its depth budget and counts it ($rep->{tooDeep} too deep, depth $rep->{maxDepth})");
    is($rep->{errors}, 0, 'with no "Too many open files" errors');
    ok($rep->{accounted}, 'and the counts add up');
}

# --- fifth review (a): an entry renamed while its directory is read -------------
{
    my $r = "$tmp/renamed";
    make_path($r);
    for my $i (1 .. 20) { open(my $f, '>', "$r/f$i") or die; close $f }
    my $done = 0;
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub {
            # The first lstat of the first pass renames every file: the pass
            # has already read the old names.
            if (!$done++) { rename("$r/f$_", "$r/g$_") for 1 .. 20 }
            return $o->(@_);
        }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/renamed.log");
    is(scalar(grep { m{/g\d+$} } @$log), 20, 'every renamed file is still acted on (the second pass)');
    is($out->{changing}, 1, 'the directory is named as changing while it was walked');
    # Sixth review: a name gone before its lstat carries no inode to match the
    # new name against, so the walk says what it saw (it cannot tell a rename
    # here from a move into a folder it has finished).
    is($out->{vanished}, 20, 'each name gone before its lstat is vanished: the walk cannot tell a rename from a move away');
    ok((grep { $_->{kind} eq 'changing' && $_->{name} eq '.' } @{ $out->{notes} }), 'the note names it');
    ok($out->{accounted});
}

# --- fifth review (b): a directory that never stops answering is bounded --------
{
    my $r = tree('endless');
    local $AnasAclWalk::READS_FLOOR = 10;
    my $calls = 0;
    local $AnasAclWalk::io{readdir} = do {
        my $o = $AnasAclWalk::io{readdir};
        # The root keeps answering the same name (a renamer in a hash-ordered
        # directory keeps a readdir going).
        sub { my $n = $o->(@_); return $n if defined $n; return ++$calls < 100000 ? 'f1' : undef }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out) = walk(job(roots => [$root]), "$tmp/endless.log");
    is($code, 0, 'the walk ends');
    ok($calls < 1000, "the endless directory was stopped after $calls extra reads");
    ok($out->{overrun} >= 1, 'it is counted');
    ok((grep { $_->{kind} eq 'overrun' } @{ $out->{notes} }), 'and named');
}

# --- fifth review (c): the job is read strictly, before anything ---------------
{
    my $r = tree('strict');
    my ($h, $root) = root_of($r);
    my %base = (roots => [{ fd => $root->{fd}, path => $r, dev => $root->{dev}, ino => $root->{ino} }], tools => \%TOOLS, mode => 'u=rwX');
    my $enc = sub { JSON::PP->new->encode(@_) };
    for my $case (
        ['an fd given as a string', sub { $_[0] =~ s/"fd":(\d+)/"fd":"$1"/ }],
        ['an fd given as a fraction', sub { $_[0] =~ s/"fd":(\d+)/"fd":$1.5/ }],
        ['setgid given as a string', sub { $_[0] =~ s/^\{/{"setgid":"true",/ }],
        ['clear given as 1', sub { $_[0] =~ s/^\{/{"clear":1,/ }],
        ['an unknown key', sub { $_[0] =~ s/^\{/{"recurse":true,/ }],
        ['an unknown root key', sub { $_[0] =~ s/"path":/"follow":true,"path":/ }],
        ['an unknown tool', sub { $_[0] =~ s/"tools":\{/"tools":{"rm":"\/bin\/rm",/ }],
        ['zfs given as a string', sub { $_[0] =~ s/"path":/"zfs":"yes","path":/ }],
    ) {
        my $text = $enc->(\%base);
        $case->[1]->($text);
        isnt($text, $enc->(\%base), "($case->[0]: the case changed the job)");
        local $ENV{FAKE_LOG} = "$tmp/strict.log";
        unlink "$tmp/strict.log";
        my ($code, $out) = AnasAclWalk::run($text);
        is($code, 2, "$case->[0]: refused");
        ok(!-e "$tmp/strict.log", "$case->[0]: nothing done");
    }
}

# --- fifth review (d): a tool holds stdio and its batch's descriptors only ------
{
    my $r = tree('fds');
    my $lister = "$tmp/lister";
    open(my $f, '>', $lister) or die;
    print $f <<'PL';
#!/usr/bin/perl
opendir(my $d, '/proc/self/fd') or die;
my $own = fileno($d);
my @fds = sort { $a <=> $b } grep { /^\d+$/ && $_ != $own } readdir($d);
my @ops = map { m{^/proc/self/fd/(\d+)$} ? $1 : () } @ARGV;
open(my $l, '>>', $ENV{FAKE_LOG}) or die;
print $l join(',', @fds), ' | ', join(',', sort { $a <=> $b } @ops), "\n";
PL
    close $f;
    chmod 0755, $lister;
    my ($h, $root) = root_of($r);
    my ($h2, $other) = root_of("$tmp");    # a second inherited descriptor no tool may hold
    my ($code, $out, $log) = walk({ roots => [$root], tools => { %TOOLS, chmod => $lister }, mode => 'u=rwX' }, "$tmp/fds.log");
    ok(@$log >= 1, 'the lister ran');
    for my $line (@$log) {
        my ($held, $ops) = split / \| /, $line;
        is($held, join(',', 0, 1, 2, split(/,/, $ops)), "a tool holds stdio and its operands only ($line)");
    }
}

# --- fifth review (e): a directory that cannot be entered says why --------------
{
    my $r = tree('enter');
    my $a_ino = (stat("$r/a"))[1];
    my %calls;
    local $AnasAclWalk::io{fstat} = do {
        my $o = $AnasAclWalk::io{fstat};
        # The second fstat of `a` is the reopened directory: not the same inode.
        sub { my $s = $o->(@_); $s->[1] += 1000000 if $s && $s->[1] == $a_ino && ++$calls{a} == 2; return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/enter.log");
    my ($n) = grep { $_->{kind} eq 'notEntered' } @{ $out->{notes} };
    is($n && $n->{message}, 'the reopened directory is not the entry that was opened', 'the note says what failed, never a stale errno');
    ok(!grep({ m{/a/f2$} } @$log), 'and the directory is not entered');
    ok($out->{accounted});
}

# --- sixth review: an entry gone between its lstat and its open -----------------
# A readdir that serves each directory's names from one read, in a chosen
# order (`first`, then the rest sorted), as the C library's buffer does: a
# name moved after the read is still served, and its lstat finds it gone.
sub ordered_readdir {
    my (@first) = @_;
    my %rank = map { $first[$_] => $_ } 0 .. $#first;
    my $o = $AnasAclWalk::io{readdir};
    my %buf;
    return sub {
        my ($dh) = @_;
        my $k = Scalar::Util::refaddr($dh);
        if (!$buf{$k}) {
            my @n;
            while (defined(my $x = $o->($dh))) { push @n, $x }
            $buf{$k} = [sort { ($rank{$a} // 1e9) <=> ($rank{$b} // 1e9) || $a cmp $b } @n];
        }
        my $x = shift @{ $buf{$k} };
        delete $buf{$k} unless defined $x;    # the next read (after rewinddir) reads again
        return $x;
    };
}
{
    # The review's renamedwindow: renamed in the same directory after its
    # lstat, before its open. Was: skipped as "already seen" in the second
    # pass, never changed, and the job completed.
    my $r = "$tmp/window";
    make_path($r);
    for my $i (1 .. 8) { open(my $f, '>', "$r/f$i") or die; close $f }
    my $done = 0;
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub { my $s = $o->(@_); if ($_[0] eq 'f5' && !$done++) { rename('f5', 'f5-renamed') or die "rename: $!" } return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/window.log");
    is($done, 1, '(the rename ran in the window)');
    ok((grep { $_ eq "setfacl -b $r/f5-renamed" } @$log), 'an entry renamed between its lstat and its open is acted on under its new name');
    is(scalar(grep { m{/f5} } @$log), 1, 'once');
    is($out->{vanished}, 0, 'it is not vanished: the walk met its inode again');
    is($out->{returned}, 1, 'it is counted as met again');
    is($out->{changing}, 1, 'the directory is named as changing');
    ok($out->{accounted}, 'the counts add up: met = accounted for, and gone = vanished + met again');
}
{
    my $r = "$tmp/windowgone";
    make_path($r);
    for my $i (1 .. 4) { open(my $f, '>', "$r/f$i") or die; close $f }
    my $f3_ino = (stat("$r/f3"))[1];
    my $done = 0;
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub { my $s = $o->(@_); if ($_[0] eq 'f3' && !$done++) { unlink('f3') or die "unlink: $!" } return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/windowgone.log");
    is($out->{vanished}, 1, 'an entry deleted between its lstat and its open is vanished');
    is($out->{changing}, 0, '(nothing new appeared)');
    my ($n) = grep { $_->{kind} eq 'vanished' } @{ $out->{notes} };
    is_deeply($n && [$n->{name}, $n->{ino}], ['f3', $f3_ino], 'the note names it and its inode');
    ok($out->{accounted});
}
{
    # The review's movedacross: entries the directory's read has already
    # listed are moved by rename(2) into a folder the walk has finished (A),
    # while a new file appears where they were. Each is vanished — a new
    # entry in the second pass takes none of them back (was: gone - new2).
    my $r = "$tmp/across";
    make_path("$r/A", "$r/B");
    for my $f ('A/am', 'B/bm', map { "f$_" } 1 .. 20) { open(my $h, '>', "$r/$f") or die; close $h }
    my $moved = 0;
    local $AnasAclWalk::io{readdir} = ordered_readdir('A', 'B');
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub {
            my $s = $o->(@_);
            if ($_[0] eq 'bm' && !$moved) {
                $moved += rename("../f$_", "../A/moved-f$_") ? 1 : 0 for 1 .. 20;
                open(my $h, '>', '../newcomer') or die;
                close $h;
            }
            return $s;
        }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/across.log");
    is($moved, 20, '(20 files moved into the finished folder)');
    ok(!grep({ m{/A/moved-} } @$log), '(the walk never meets them again: they are in a folder it finished)');
    is($out->{vanished}, 20, 'every one of them is vanished');
    ok((grep { $_ eq "setfacl -b $r/newcomer" } @$log), 'the new file is acted on');
    is($out->{changing}, 1, 'and the folder is named as changing');
    is(scalar(grep { $_->{kind} eq 'vanished' } @{ $out->{notes} }), 20, 'each vanished entry is named');
    ok($out->{accounted});
}
{
    # A name only the second read lists, gone before its lstat: counted in
    # the second pass too (was: skipped as "the first pass counted it").
    my $r = "$tmp/late";
    make_path("$r/A");
    for my $f ('A/am', 'f1', 'f2') { open(my $h, '>', "$r/$f") or die; close $h }
    my ($made, $moved) = (0, 0);
    local $AnasAclWalk::io{readdir} = ordered_readdir('A');
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub {
            my $s = $o->(@_);
            if ($_[0] eq 'f2' && !$made++) { open(my $h, '>', 'late') or die; close $h }    # after the first read
            elsif ($_[0] eq 'A' && $made && !$moved++) { rename('late', 'A/late') or die "rename: $!" }    # the second pass's first lstat
            return $s;
        }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/late.log");
    is($moved, 1, '(the late file moved into the finished folder after the second read listed it)');
    ok(!grep({ m{\Q$r\E/(?:A/)?late$} } @$log), '(never acted on)');
    is($out->{vanished}, 1, 'a name gone before its lstat in the second pass is vanished');
    ok($out->{accounted});
}

# --- sixth review: each identity check holds on its own (each masks the other in
# the race suite; these are real renames, no seam answers a lie) ------------------
{
    # O_NOFOLLOW alone: between the lstat and the open the name becomes a link
    # to the very inode the lstat saw. The fstat compare cannot tell (a
    # followed link would bring back that inode); only the open's no-follow
    # keeps the walk off it.
    my $r = "$tmp/nofollow";
    make_path($r);
    for my $f (qw(x f1)) { open(my $h, '>', "$r/$f") or die; close $h }
    my $done = 0;
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub { my $s = $o->(@_); if ($_[0] eq 'x' && !$done) { $done = 1; rename('x', 'y') or die; symlink('y', 'x') or die } return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/nofollow.log");
    is($done, 1, '(the swap ran in the window)');
    ok(!grep({ m{/y$} } @$log), 'a name turned into a link between the lstat and the open is never followed, not even back to the inode the lstat saw');
    is($out->{swapped}, 1, 'it is counted as swapped');
}
{
    # The fstat compare alone: between the lstat and the open another file (a
    # hard link of a file outside the tree) is renamed onto the name, and it
    # is moved out again once the walk has its descriptor — a plain file, so
    # O_NOFOLLOW has nothing to refuse.
    my $r = "$tmp/compare";
    my $out_dir = "$tmp/compare-out";
    make_path($r, $out_dir);
    for my $f ("$r/x", "$r/f1", "$out_dir/victim") { open(my $h, '>', $f) or die; close $h }
    link("$out_dir/victim", "$out_dir/hl") or die;
    my $victim_ino = (stat("$out_dir/victim"))[1];
    my ($swapped_in, $back) = (0, 0);
    local $AnasAclWalk::io{lstat} = do {
        my $o = $AnasAclWalk::io{lstat};
        sub { my $s = $o->(@_); if ($_[0] eq 'x' && !$swapped_in++) { rename("$out_dir/hl", 'x') or die } return $s }
    };
    local $AnasAclWalk::io{fstat} = do {
        my $o = $AnasAclWalk::io{fstat};
        # A true answer; then the file leaves the tree again.
        sub { my $s = $o->(@_); if ($s && $s->[1] == $victim_ino && !$back++) { rename('x', "$out_dir/hl") or die } return $s }
    };
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/compare.log");
    is($back, 1, '(the outside file was opened under the swapped name, and moved out again)');
    ok(!grep({ m{compare-out} } @$log), 'a file swapped onto a name between the lstat and the open is never acted on');
    is($out->{swapped}, 1, 'it is counted as swapped');
}

# --- cr3.nodefix D3: a bind mount of a SIBLING folder (same filesystem) ---------
# `mount --bind <dir>/d2 <dir>/<name>`: the bind's lstat answers d2's device
# and inode, only its mount id differs. On the ZFS-root node (second cr3 node
# pass, again in cr3.nodefix): bind met SECOND — never met, the job INCOMPLETE
# with a false sentence; bind met FIRST — the boundary recorded, then d2
# skipped as "already seen": d2/f* stayed 700 and the job said complete.
# Simulated through the io seam: `bind` is a real empty folder whose lstat,
# fstat and mount id answer what a bind of d2 answers (d2's device and inode,
# another mount).
sub sibling_bind_tree {
    my ($name) = @_;
    my $r = "$tmp/$name";
    make_path("$r/d2", "$r/bind");
    for my $f ('f1', 'd2/f5', 'd2/f6') { open(my $h, '>', "$r/$f") or die; close $h }
    my @d2 = lstat("$r/d2");
    my $bind_ino = (stat("$r/bind"))[1];
    my $is_bind = sub { my @s = stat("/proc/self/fd/$_[0]"); return @s && $s[1] == $bind_ino };
    my %seam = (
        lstat => do { my $o = $AnasAclWalk::io{lstat}; sub { return $_[0] eq 'bind' ? [@d2] : $o->(@_) } },
        fstat => do { my $o = $AnasAclWalk::io{fstat}; sub { my $s = $o->(@_); return $s && $s->[1] == $bind_ino ? [@d2] : $s } },
        mnt => do { my $o = $AnasAclWalk::io{mnt}; sub { my $m = $o->(@_); return defined $m && $is_bind->($_[0]) ? $m + 1000 : $m } },
    );
    return ($r, \%seam, $d2[1]);
}
for my $order (['bind', 'd2'], ['d2', 'bind']) {
    my $first = $order->[0];
    my ($r, $seam, $d2_ino) = sibling_bind_tree("sibling-$first-first");
    local $AnasAclWalk::io{readdir} = ordered_readdir(@$order);
    local $AnasAclWalk::io{lstat} = $seam->{lstat};
    local $AnasAclWalk::io{fstat} = $seam->{fstat};
    local $AnasAclWalk::io{mnt} = $seam->{mnt};
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/sibling-$first.log");
    is($code, 0, "($first met first) the walk completes");
    is_deeply([grep { m{/d2} } @$log], ["setfacl -b $r/d2", "setfacl -b $r/d2/f5", "setfacl -b $r/d2/f6"],
        "RED ($first met first): the real folder and everything in it are walked");
    ok(!grep({ m{/bind$} } @$log), "($first met first) the bind is never touched");
    is($out->{boundary}, 1, "RED ($first met first): the bind is the one boundary, reported once over both reads");
    my ($b) = @{ $out->{boundaries} };
    is_deeply($b && [$b->{name}, $b->{ino}], ['bind', $d2_ino], "($first met first) named with the identity a bind shows (its source's inode)");
    ok($b && $b->{mnt} >= 1000, "($first met first) and its own mount");
    is_deeply([$out->{changing}, $out->{vanished}, $out->{swapped}, $out->{errors}], [0, 0, 0, 0], "($first met first) nothing changing, vanished, swapped or failed");
    ok($out->{accounted}, "($first met first) the counts add up");
}
{
    # The inode again under another name on the SAME mount is the entry
    # already met (a hard link here; a rename while the folder is read is the
    # same case): opened to read its mount, then skipped as before — acted on
    # once, no boundary, nothing changing.
    my $r = "$tmp/hardlink";
    make_path($r);
    open(my $f, '>', "$r/h1") or die;
    close $f;
    link("$r/h1", "$r/h2") or die;
    my ($h, $root) = root_of($r);
    my ($code, $out, $log) = walk(job(roots => [$root]), "$tmp/hardlink.log");
    is(scalar(grep { m{/h[12]$} } @$log), 1, 'two hard links in one folder: acted on once');
    is_deeply([$out->{boundary}, $out->{changing}, $out->{errors}], [0, 0, 0], 'no boundary, nothing changing, no error');
    is_deeply($out->{visited}, { files => 1, dirs => 1 }, 'met once');
    ok($out->{accounted});
}

chdir '/';    # the helper leaves its cwd in the last walked directory
done_testing();
