#!/usr/bin/perl
#
# anas-acl-walk — the recursive permission walk of "apply to existing files"
# (cr3.shares, fourth and fifth reviews). It ships beside the
# daemon's compiled services; the daemon runs it as `/usr/bin/perl <this
# file>` with the walk ROOTS already opened and proven (inherited at fd 3,
# 4, ...) and the job as one JSON object on stdin — never in argv.
#
# Why a helper: find(1) names every entry it acts on as `./name` relative to
# the directory it opened, and each tool resolves that name AGAIN when it runs
# — a share user who swaps the name for a symbolic link in between redirects
# the write (acl 2.3.2 `setfacl -P` follows it; coreutils 9.7 `chmod -h`
# races; GNU find `-fstype btrfs` matches nothing on btrfs). Here no tool ever
# resolves a name, and no path is ever built from names for a syscall:
#
#   per directory entry (the directory is the process's cwd, entered through
#   its descriptor):
#     1. lstat(name)                                  type, device, inode
#     2. open(name, O_PATH|O_NOFOLLOW)                the entry, pinned
#     3. fstat(fd)                                    must be the lstat's type,
#                                                     device and inode
#     4. /proc/self/fdinfo/<fd> `mnt_id:`             the MOUNT it sits on
#   then every write names /proc/self/fd/N — the kernel resolves that to the
#   pinned inode whatever the name says by then — and a directory is entered
#   by reopening the SAME descriptor (opendir /proc/self/fd/N, fstat proves the
#   inode again, fchdir). Coming back up is fchdir to the parent's open handle,
#   never `..`.
#
#   - Only regular files and directories are touched; links, FIFOs, sockets
#     and device nodes are counted and skipped.
#   - THE BOUNDARY (fifth review D2) is the mount AND the device: an entry on
#     another mount than its root (another filesystem, a bind mount of the
#     SAME filesystem, a second mount of the same dataset or subvolume) or on
#     another device (a nested btrfs subvolume) is never entered or touched.
#     A nested root the plan named (a child dataset, a btrfs subvolume of the
#     tree) is walked as a root of its own; every other boundary is reported
#     with its path as seen, device, inode and mount id, for the daemon to
#     match against what the confirmation named.
#   - `.zfs` at the top of a ZFS root is the snapshot control directory and
#     is never part of the data.
#   - An entry that changed between steps 1 and 3 (swapped) is not touched and
#     is counted; the walk goes on. The daemon calls such a result INCOMPLETE.
#   - Each directory is read twice (fifth review (a)): after the first pass a
#     second one acts on every entry whose inode the first did not see (an
#     entry renamed while the directory was read); if it finds any, the
#     directory changed while it was walked and the result says so. The reads
#     of one directory are bounded (fifth review (b)): a share user renaming
#     without end cannot keep root's walk busy for ever.
#   - An entry whose name was gone by the time it was looked at or opened
#     (ENOENT) is VANISHED (sixth review): the walk cannot tell a move from a
#     delete, and a move into a folder the walk has finished is never met
#     again. An entry met by lstat whose open found it gone is not "seen" by
#     inode: meeting the same inode again under another name in the same
#     directory acts on it (through the whole lstat/open/fstat chain) and
#     takes it back out of the vanished count. The daemon calls any vanished
#     entry INCOMPLETE.
#   - Regular files with more than one hard link are walked like any other
#     entry (coordinator ruling, fifth review): skipping them would leave
#     legitimate hard-link trees (snapshot-style backup directories) without
#     the permissions the administrator asked for; the exposure is inherent
#     to applying permissions to existing contents and is bounded by
#     fs.protected_hardlinks.
#
# The writes are the real tools, in batches, with /proc/self/fd/N operands:
# chown(1), setfacl(1) and chmod(1) without any no-follow flag — the operand
# is a magic link to the pinned inode, which is exactly what each tool must
# reach (`-h`/`-P` would act on the magic link itself). A tool process holds
# stdio and its batch's descriptors and nothing else. Each entry gets the
# steps in the daemon's order: chown; setfacl -b -m (access ACL); setfacl -d
# --set (directories); chmod g+s (directories); setfacl -b -k (clear); chmod
# <mode>. A tool that fails without naming every operand it failed on is run
# again one operand at a time, so every entry is either changed or reported.
#
# Output: ONE bounded JSON line of counts on stdout (well under the daemon's
# capture limit, whatever the names in the tree). The counts add up: every
# entry met is in exactly one outcome, and per step changed + failed = the
# entries the step applies to; `accounted` says the helper checked it.
# Exit 0: the walk completed (skips and errors are in the counts); 2: refused
# before anything was changed; 3: stopped part-way (the counts say how far).
#
package AnasAclWalk;

use strict;
use warnings;

use B ();
use Errno qw(ENOENT);
use Fcntl qw(O_NOFOLLOW F_SETFD S_IFMT S_ISDIR S_ISREG S_ISLNK);
use JSON::PP ();
use POSIX ();

# Linux's O_PATH (include/uapi/asm-generic/fcntl.h, 010000000 — the value on
# x86_64 and arm64; Perl's Fcntl does not export it).
use constant O_PATH => 010000000;
# Operands per tool invocation, at most (one O_PATH descriptor each stays open
# until its batch has run); a low descriptor limit shrinks it.
use constant BATCH_MAX => 128;
use constant BATCH_MIN => 4;
# Descriptors kept back from the depth budget besides the batch and the roots
# (stdio, a tool's pipe, an fdinfo read, the child's /proc/self/fd listing).
use constant FD_RESERVE => 16;
# Deepest directory nesting entered when the descriptor limit allows it.
use constant MAX_DEPTH => 1024;
# Notes (swapped, errors, too deep, ...) and boundaries carried back.
use constant NOTES_KEPT => 50;
use constant BOUNDARIES_KEPT => 200;
# A path in a note: longer than this keeps its head and tail and says its length.
use constant NAME_KEPT => 160;
use constant NAME_HEAD => 64;
# A tool's message in a note.
use constant MESSAGE_KEPT => 300;
# Bytes of one tool's stderr read back (enough for an error per operand).
use constant STDERR_KEPT => 262144;
# Reads of one directory (both passes): at most this many times the distinct
# entries it has shown, and never fewer than READS_FLOOR (fifth review (b)).
use constant READS_FACTOR => 4;
use constant READS_FLOOR => 1024;

our $LIMITS = '/proc/self/limits';
# The whole report, at most (the daemon captures 10 MiB).
our $REPORT_MAX = 1048576;
# The reads floor, as a variable so a unit test can lower it.
our $READS_FLOOR = READS_FLOOR;
# A tool child's own handles on its operands (never closed: it execs).
our @held;

# The filesystem calls — a seam for the unit tests (a nested btrfs subvolume
# or a same-device bind mount simulated by a device or mount number).
# Production never replaces them.
our %io = (
    lstat => sub { my @s = lstat($_[0]); return @s ? \@s : undef },
    fstat => sub { my @s = stat($_[0]); return @s ? \@s : undef },
    mnt   => sub { return mnt_id_of_fd($_[0]) },
    readdir => sub { return scalar readdir($_[0]) },
);

# The steps, in the daemon's order: [job key, which entries, argv builder].
my @STEPS = (
    ['chown',      'all',  sub { my ($j) = @_; [$j->{tools}{chown}, $j->{chown}, '--'] }],
    ['acl',        'all',  sub { my ($j) = @_; [$j->{tools}{setfacl}, '-b', '-m', $j->{acl}, '--'] }],
    ['defaultAcl', 'dirs', sub { my ($j) = @_; [$j->{tools}{setfacl}, '-d', '--set', $j->{defaultAcl}, '--'] }],
    ['setgid',     'dirs', sub { my ($j) = @_; [$j->{tools}{chmod}, 'g+s', '--'] }],
    ['clear',      'all',  sub { my ($j) = @_; [$j->{tools}{setfacl}, '-b', '-k', '--'] }],
    ['mode',       'all',  sub { my ($j) = @_; [$j->{tools}{chmod}, $j->{mode}, '--'] }],
);

# The mount id of an open descriptor (fdinfo has carried `mnt_id:` for every
# descriptor, O_PATH ones included, since Linux 3.15). Undef when unreadable.
sub mnt_id_of_fd {
    my ($fd) = @_;
    open(my $f, '<', "/proc/self/fdinfo/$fd") or return undef;
    local $/ = "\n";
    while (my $line = <$f>) {
        if ($line =~ /^mnt_id:\s*(\d+)/) {
            close $f;
            return $1 + 0;
        }
    }
    close $f;
    return undef;
}

sub new_state {
    my ($job, $max_depth, $batch_max) = @_;
    return {
        job => $job,
        maxDepth => $max_depth,
        batchMax => $batch_max // BATCH_MAX,
        batch => [],
        seen => 0,
        visited => { files => 0, dirs => 0 },
        changed => { map { $_->[0] => 0 } @STEPS },
        failed => { map { $_->[0] => 0 } @STEPS },
        eligible => { map { $_->[0] => 0 } @STEPS },
        skipped => { links => 0, other => 0 },
        swapped => 0,
        gone => 0,
        vanished => 0,
        returned => 0,
        boundary => 0,
        boundaries => [],
        boundariesDropped => 0,
        nestedRoots => 0,
        zfsControl => 0,
        tooDeep => 0,
        notEntered => 0,
        unreadable => 0,
        changing => 0,
        overrun => 0,
        notes => [],
        notesDropped => 0,
    };
}

# A path for the report: never longer than NAME_KEPT bytes — its head and
# tail, and how long it was (fifth review D4: a share user's names cannot
# grow the report). Built from the walk stack's names, only when reported.
sub short_path {
    my ($stack, $name) = @_;
    my @parts = ((map { $_->{name} } grep { defined $_->{name} } @$stack), defined $name ? ($name) : ());
    return '.' unless @parts;
    my $len = -1;
    $len += length($_) + 1 for @parts;
    return join('/', @parts) if $len <= NAME_KEPT;
    my $head = '';
    for my $p (@parts) {
        $head .= ($head eq '' ? '' : '/') . $p;
        last if length($head) >= NAME_HEAD;
    }
    my $tail = '';
    for my $p (reverse @parts) {
        $tail = $p . ($tail eq '' ? '' : '/') . $tail;
        last if length($tail) >= NAME_HEAD;
    }
    return substr($head, 0, NAME_HEAD) . "[...$len bytes...]" . substr($tail, -NAME_HEAD);
}

sub note {
    my ($st, %n) = @_;
    $n{message} = substr($n{message}, 0, MESSAGE_KEPT) if defined $n{message} && length($n{message}) > MESSAGE_KEPT;
    if (@{ $st->{notes} } < NOTES_KEPT) {
        push @{ $st->{notes} }, \%n;
    }
    else {
        $st->{notesDropped}++;
    }
}

sub step_enabled {
    my ($job, $key) = @_;
    return $key eq 'setgid' || $key eq 'clear' ? ($job->{$key} ? 1 : 0) : (defined $job->{$key} ? 1 : 0);
}

sub member_fd {
    my ($m) = @_;
    return $m->{fh} ? fileno($m->{fh}) : $m->{fd};
}

# Run one tool over the members' descriptors as /proc/self/fd/N operands;
# returns ({ fd => message } for every operand the tool named in an error,
# the reason when it failed, its wait status).
sub run_tool {
    my ($argv, $members) = @_;
    my @fds = map { member_fd($_) } @$members;
    pipe(my $r, my $w) or return ({}, "pipe: $!", 1);
    my $pid = fork;
    if (!defined $pid) {
        close $r;
        close $w;
        return ({}, "fork: $!", 1);
    }
    if ($pid == 0) {
        close $r;
        open(STDOUT, '>&', $w) or POSIX::_exit(126);
        open(STDERR, '>&', $w) or POSIX::_exit(126);
        # The tool holds stdio and its operands' descriptors, nothing else
        # (fifth review (d)): every other descriptor is closed, and the
        # operands' close-on-exec is cleared — in this child only.
        my %keep = map { $_ => 1 } (0, 1, 2, @fds);
        if (opendir(my $d, '/proc/self/fd')) {
            my @open = grep { /^\d+$/ } readdir($d);
            closedir($d);
            for my $fd (@open) {
                POSIX::close($fd) unless $keep{$fd};
            }
        }
        for my $fd (@fds) {
            open(my $h, '<&=', $fd) or POSIX::_exit(126);
            fcntl($h, F_SETFD, 0) or POSIX::_exit(126);
            # $h is never closed: the process execs below.
            push @held, $h;
        }
        my @argv = (@$argv, map { "/proc/self/fd/$_" } @fds);
        { no warnings 'exec'; exec { $argv[0] } @argv; }
        POSIX::_exit(127);
    }
    close $w;
    my $text = '';
    while (1) {
        my $n = sysread($r, my $buf, 65536);
        last if !$n;
        $text .= $buf if length($text) < STDERR_KEPT;
    }
    close $r;
    waitpid($pid, 0);
    my $status = $?;
    my %by_fd;
    for my $line (split /\n/, $text) {
        if ($line =~ m{/proc/self/fd/(\d+)'?:\s*(.*)$}) {
            $by_fd{$1} //= $2;
        }
    }
    my $why = $status == 0 ? undef
        : ($status & 127) ? 'killed by signal ' . ($status & 127)
        : 'exited ' . ($status >> 8) . ($text ne '' ? ': ' . (split /\n/, $text)[0] : '');
    return (\%by_fd, $why, $status);
}

sub step_failed {
    my ($st, $key, $m, $message) = @_;
    $st->{failed}{$key}++;
    note($st, kind => 'error', op => $key, ino => $m->{ino}, name => $m->{rel}, message => $message);
}

# Act on the pending batch: every enabled step, in order, over its members.
# Fifth review D3: when a tool fails, every operand it named is failed, and
# every operand it did NOT name is run again on its own — each entry ends
# either changed or reported.
sub flush {
    my ($st) = @_;
    my $batch = $st->{batch};
    return unless @$batch;
    my $job = $st->{job};
    for my $step (@STEPS) {
        my ($key, $which, $build) = @$step;
        next unless step_enabled($job, $key);
        my @members = grep { $which eq 'all' || $_->{dir} } @$batch;
        next unless @members;
        $st->{eligible}{$key} += @members;
        my ($by_fd, $why, $status) = run_tool($build->($job), \@members);
        if ($status == 0 && !%$by_fd) {
            $st->{changed}{$key} += @members;
            next;
        }
        for my $m (@members) {
            my $fd = member_fd($m);
            if (exists $by_fd->{$fd}) {
                step_failed($st, $key, $m, $by_fd->{$fd});
                next;
            }
            if ($status == 0) {
                $st->{changed}{$key}++;
                next;
            }
            my ($one, $one_why, $one_status) = run_tool($build->($job), [$m]);
            if ($one_status == 0 && !%$one) {
                $st->{changed}{$key}++;
            }
            else {
                step_failed($st, $key, $m, $one->{$fd} // $one_why // 'failed');
            }
        }
    }
    for my $m (@$batch) {
        close($m->{fh}) if $m->{fh};
    }
    @$batch = ();
}

sub add {
    my ($st, $entry) = @_;
    $st->{visited}{ $entry->{dir} ? 'dirs' : 'files' }++;
    push @{ $st->{batch} }, $entry;
    flush($st) if @{ $st->{batch} } >= $st->{batchMax};
}

sub same_object {
    my ($a, $b) = @_;
    return $a && $b && $a->[0] == $b->[0] && $a->[1] == $b->[1] && ($a->[2] & S_IFMT) == ($b->[2] & S_IFMT);
}

# An entry on another mount or device than its root: a nested root the plan
# named, or a boundary reported with its identity.
sub other_side {
    my ($st, $stat, $mnt, $root_ids, $stack, $name) = @_;
    if (S_ISDIR($stat->[2]) && defined $mnt && $root_ids->{"$stat->[0]:$stat->[1]:$mnt"}) {
        $st->{nestedRoots}++;
        return;
    }
    $st->{boundary}++;
    if (@{ $st->{boundaries} } < BOUNDARIES_KEPT) {
        # Mount ids are reused once a mount is gone, and so are anonymous
        # device numbers: the identity also carries WHERE it was met — the
        # directory's inode and the entry's own name (a mountpoint cannot be
        # renamed while mounted).
        push @{ $st->{boundaries} }, {
            name => short_path($stack, $name),
            leaf => $name,
            parent => $stack->[-1]{ino} + 0,
            dev => $stat->[0] + 0,
            ino => $stat->[1] + 0,
            mnt => defined $mnt ? $mnt + 0 : undef,
        };
    }
    else {
        $st->{boundariesDropped}++;
    }
}

# Finish a directory's pass: the first pass is followed by a second over the
# same handle; the second ends the directory.
sub end_pass {
    my ($st, $top, $stack) = @_;
    if ($top->{pass} == 1) {
        rewinddir($top->{dh});
        $top->{pass} = 2;
        return 0;
    }
    # Fifth review (a): entries the second pass found are entries renamed (or
    # created) while the directory was read — acted on, and the directory is
    # named as changing.
    if ($top->{new2} > 0) {
        $st->{changing}++;
        note($st, kind => 'changing', name => $top->{rel_for_note});
    }
    # Sixth review: an entry whose open found it gone and whose inode this
    # directory never showed again stays vanished; it is named now.
    for my $key (sort keys %{ $top->{lost} }) {
        my ($ino) = $key =~ /:(\d+)$/;
        note($st, kind => 'vanished', ino => $ino + 0, name => short_path($stack, $top->{lost}{$key}));
    }
    return 1;
}

# An entry whose name was gone (ENOENT) when the walk looked at or opened it:
# a meeting that ended VANISHED (sixth review). `key` is its inode when the
# lstat had found it — the entry is then not "seen" by inode, so meeting it
# again under another name acts on it.
sub gone_entry {
    my ($st, $top, $stack, $name, $key) = @_;
    $st->{gone}++;
    $st->{vanished}++;
    if (defined $key) {
        delete $top->{ids}{$key};
        $top->{lost}{$key} = $name;
    }
    else {
        note($st, kind => 'vanished', name => short_path($stack, $name));
    }
}

# cr3.nodefix D3: an entry whose inode this directory already showed under
# another name — a hard link, an entry renamed while the directory was read,
# or a bind mount of a sibling (the mountpoint's lstat answers the bind's
# source). It is opened and proven like any entry (O_PATH|O_NOFOLLOW, fstat,
# mount id) and met only when it sits on another mount or device than the
# root: then it is a boundary like any other (once per name). On the root's
# own mount it is the entry already met, and stays skipped as before; so does
# one that could not be opened or proven (nothing is ever acted on here).
sub sibling_bind {
    my ($st, $root, $root_ids, $top, $stack, $name, $l, $key) = @_;
    return unless S_ISDIR($l->[2]) || S_ISREG($l->[2]);
    my $fh;
    sysopen($fh, $name, O_PATH | O_NOFOLLOW) or return;
    my $f = $io{fstat}->($fh);
    my $mnt = same_object($l, $f) ? $io{mnt}->(fileno($fh)) : undef;
    close $fh;
    return if !defined $mnt || ($f->[0] == $root->{dev} && $mnt == $root->{mnt});
    $st->{seen}++;
    $top->{new2}++ if $top->{pass} == 2;
    $top->{bounds}{$name} = $key;
    other_side($st, $f, $mnt, $root_ids, $stack, $name);
}

# Walk one root (already proven by check_roots). Dies only on a failure that
# leaves the walk unable to continue (it cannot get back to a directory).
sub walk_root {
    my ($st, $root, $root_ids) = @_;
    my $dh = $root->{dh};
    # The root itself, through its inherited descriptor.
    $st->{seen}++;
    add($st, { fh => undef, fd => $root->{fd}, dir => 1, ino => $root->{ino}, rel => '.', name => '.' });
    chdir($dh) or die "could not enter the root '$root->{path}': $!\n";
    my @stack = ({ dh => $dh, ino => $root->{ino}, name => undef, depth => 0, own => 0, pass => 1, ids => {}, bounds => {}, lost => {}, reads => 0, new2 => 0, rel_for_note => '.' });
    while (@stack) {
        my $top = $stack[-1];
        my $name = $io{readdir}->($top->{dh});
        if (!defined $name) {
            next unless end_pass($st, $top, \@stack);
            my $done = pop @stack;
            closedir($done->{dh}) if $done->{own};
            if (@stack) {
                chdir($stack[-1]{dh}) or die "could not return to a directory under '$root->{path}': $!\n";
            }
            next;
        }
        next if $name eq '.' || $name eq '..';
        # Fifth review (b): a directory that keeps answering (a renamer in a
        # hash-ordered directory) is stopped and named.
        $top->{reads}++;
        my $distinct = scalar keys %{ $top->{ids} };
        if ($top->{reads} > READS_FACTOR * ($distinct > $READS_FLOOR ? $distinct : $READS_FLOOR)) {
            $st->{overrun}++;
            note($st, kind => 'overrun', name => $top->{rel_for_note});
            $top->{pass} = 2;
            $top->{new2} = 0;
            end_pass($st, $top, \@stack);
            my $done = pop @stack;
            closedir($done->{dh}) if $done->{own};
            chdir($stack[-1]{dh}) or die "could not return to a directory under '$root->{path}': $!\n" if @stack;
            next;
        }
        if ($top->{depth} == 0 && $root->{zfs} && $name eq '.zfs') {
            $st->{zfsControl}++ if $top->{pass} == 1;
            next;
        }
        my $l = $io{lstat}->($name);
        if (!$l) {
            my $errno = $! + 0;
            my $err = "$!";
            if ($errno == ENOENT) {
                # Gone in either pass (sixth review): a name listed and gone
                # before it could be looked at may be an entry moved where
                # the walk will not look again — never a quiet skip.
                $st->{seen}++;
                gone_entry($st, $top, \@stack, $name, undef);
                next;
            }
            next if $top->{pass} == 2;    # unreadable again: the first pass counted what it saw
            $st->{seen}++;
            $st->{unreadable}++;
            note($st, kind => 'error', op => 'lstat', name => short_path(\@stack, $name), message => $err);
            next;
        }
        # One entry, once: an inode this directory already showed (under this
        # name or another one) is not met again — unless its open found it
        # gone (gone_entry): then this meeting is the first that can act.
        # cr3.nodefix D3: only an entry the walk did NOT find on another
        # mount claims its inode here (a boundary is remembered by its name
        # instead), and the inode met again under ANOTHER name is looked at
        # once more: a bind mount of a sibling shows the sibling's inode, and
        # only its mount tells it apart (sibling_bind). So whichever comes
        # first, the folder is walked and the bind is the named boundary.
        my $key = "$l->[0]:$l->[1]";
        next if defined $top->{bounds}{$name} && $top->{bounds}{$name} eq $key;
        if (exists $top->{ids}{$key}) {
            sibling_bind($st, $root, $root_ids, $top, \@stack, $name, $l, $key) if $top->{ids}{$key} ne $name;
            next;
        }
        $top->{ids}{$key} = $name;
        $st->{seen}++;
        $top->{new2}++ if $top->{pass} == 2;
        if (exists $top->{lost}{$key}) {
            delete $top->{lost}{$key};
            $st->{vanished}--;
            $st->{returned}++;
        }
        my $mode = $l->[2];
        if (S_ISLNK($mode)) {
            $st->{skipped}{links}++;
            next;
        }
        if (!S_ISREG($mode) && !S_ISDIR($mode)) {
            $st->{skipped}{other}++;
            next;
        }
        my $fh;
        if (!sysopen($fh, $name, O_PATH | O_NOFOLLOW)) {
            my $errno = $! + 0;
            my $err = "$!";
            if ($errno == ENOENT) {
                gone_entry($st, $top, \@stack, $name, $key);
            }
            else {
                $st->{unreadable}++;
                note($st, kind => 'error', op => 'open', ino => $l->[1], name => short_path(\@stack, $name), message => $err);
            }
            next;
        }
        my $f = $io{fstat}->($fh);
        if (!same_object($l, $f)) {
            close $fh;
            $st->{swapped}++;
            note($st, kind => 'swapped', ino => $l->[1], name => short_path(\@stack, $name));
            next;
        }
        my $mnt = $io{mnt}->(fileno($fh));
        if (!defined $mnt) {
            close $fh;
            $st->{unreadable}++;
            note($st, kind => 'error', op => 'mount id', ino => $f->[1], name => short_path(\@stack, $name), message => 'its mount could not be read');
            next;
        }
        if ($f->[0] != $root->{dev} || $mnt != $root->{mnt}) {
            close $fh;
            # cr3.nodefix D3: a boundary does not claim the inode — a sibling
            # it is a bind mount of is still walked when it comes later.
            delete $top->{ids}{$key};
            $top->{bounds}{$name} = $key;
            other_side($st, $f, $mnt, $root_ids, \@stack, $name);
            next;
        }
        my $rel = short_path(\@stack, $name);
        my $is_dir = S_ISDIR($f->[2]);
        if (!$is_dir) {
            add($st, { fh => $fh, dir => 0, ino => $f->[1], rel => $rel, name => $name });
            next;
        }
        # A directory: entered through the SAME inode — the pinned descriptor
        # reopened for reading (proven by fstat), BEFORE the descriptor joins
        # a batch that may run and close it.
        my $cdh;
        my $enter = $top->{depth} + 1 <= $st->{maxDepth};
        my $why;
        if ($enter) {
            if (!opendir($cdh, '/proc/self/fd/' . fileno($fh))) {
                $why = "$!";
                undef $cdh;
            }
            elsif (!same_object($f, $io{fstat}->($cdh))) {
                $why = 'the reopened directory is not the entry that was opened';
                closedir($cdh);
                undef $cdh;
            }
        }
        add($st, { fh => $fh, dir => 1, ino => $f->[1], rel => $rel, name => $name });
        if (!$enter) {
            $st->{tooDeep}++;
            note($st, kind => 'tooDeep', ino => $f->[1], name => $rel);
            next;
        }
        if (!$cdh || !chdir($cdh)) {
            $why //= "$!";
            closedir($cdh) if $cdh;
            $st->{notEntered}++;
            note($st, kind => 'notEntered', ino => $f->[1], name => $rel, message => $why);
            next;
        }
        push @stack, { dh => $cdh, ino => $f->[1], name => $name, depth => $top->{depth} + 1, own => 1, pass => 1, ids => {}, bounds => {}, lost => {}, reads => 0, new2 => 0, rel_for_note => $rel };
    }
}

# Open and prove every root BEFORE anything is changed: its device and inode
# are the plan's, and its mount can be read (never a walk by device only).
sub check_roots {
    my ($roots) = @_;
    for my $root (@$roots) {
        my $dh;
        opendir($dh, "/proc/self/fd/$root->{fd}") or return "the walk root '$root->{path}' (fd $root->{fd}) could not be opened: $!";
        my $s = $io{fstat}->($dh);
        if (!$s || !S_ISDIR($s->[2]) || $s->[0] != $root->{dev} || $s->[1] != $root->{ino}) {
            return "the walk root '$root->{path}' is not the directory the change was planned for";
        }
        my $mnt = $io{mnt}->($root->{fd});
        return "the mount of the walk root '$root->{path}' could not be read (/proc/self/fdinfo/$root->{fd}): the walk does not start without it" unless defined $mnt;
        $root->{dh} = $dh;
        $root->{mnt} = $mnt;
    }
    return undef;
}

sub is_int {
    my ($v) = @_;
    return 0 if !defined $v || ref $v;
    my $f = B::svref_2object(\$v)->FLAGS;
    return ($f & B::SVf_IOK) && !($f & B::SVf_POK) && $v >= 0 ? 1 : 0;
}

sub is_str {
    my ($v) = @_;
    return 0 if !defined $v || ref $v;
    my $f = B::svref_2object(\$v)->FLAGS;
    return ($f & B::SVf_POK) && !($f & (B::SVf_IOK | B::SVf_NOK)) ? 1 : 0;
}

sub is_bool {
    my ($v) = @_;
    return ref($v) eq 'JSON::PP::Boolean' ? 1 : 0;
}

my %JOB_KEYS = map { $_ => 1 } qw(roots tools chown acl defaultAcl setgid clear mode);
my %ROOT_KEYS = map { $_ => 1 } qw(fd path dev ino zfs);
my %TOOL_KEYS = map { $_ => 1 } qw(chown chmod setfacl);

# Fifth review (c): the job is read strictly, before anything changes —
# integers are JSON integers, booleans JSON booleans, strings strings, and a
# key nobody defined is refused.
sub validate {
    my ($job) = @_;
    return 'the job is not an object' unless ref $job eq 'HASH';
    for my $k (sort keys %$job) {
        return "the job carries an unknown key '$k'" unless $JOB_KEYS{$k};
    }
    return 'the job names no roots' unless ref $job->{roots} eq 'ARRAY' && @{ $job->{roots} };
    my %fds;
    for my $r (@{ $job->{roots} }) {
        return 'a root is not an object' unless ref $r eq 'HASH';
        for my $k (sort keys %$r) {
            return "a root carries an unknown key '$k'" unless $ROOT_KEYS{$k};
        }
        return 'a root\'s fd, dev and ino must be JSON integers' unless is_int($r->{fd}) && is_int($r->{dev}) && is_int($r->{ino});
        return 'a root\'s fd must be 3 or above' unless $r->{fd} >= 3;
        return 'two roots name the same fd' if $fds{ $r->{fd} }++;
        return 'a root\'s path must be a string' unless is_str($r->{path});
        return 'a root\'s zfs must be a JSON boolean' if exists $r->{zfs} && !is_bool($r->{zfs});
    }
    return 'the job names no tools' unless ref $job->{tools} eq 'HASH';
    for my $k (sort keys %{ $job->{tools} }) {
        return "the tools carry an unknown key '$k'" unless $TOOL_KEYS{$k};
    }
    for my $t (sort keys %TOOL_KEYS) {
        return "the $t tool is not an absolute path" unless is_str($job->{tools}{$t}) && $job->{tools}{$t} =~ m{^/[^\0]*$};
    }
    for my $k (qw(chown acl defaultAcl mode)) {
        next unless exists $job->{$k};
        return "$k is not a plain string" unless is_str($job->{$k}) && $job->{$k} ne '' && $job->{$k} !~ /[\0\n]/ && $job->{$k} !~ /^-/;
    }
    for my $k (qw(setgid clear)) {
        return "$k must be a JSON boolean" if exists $job->{$k} && !is_bool($job->{$k});
    }
    return 'the job changes nothing' unless grep { step_enabled($job, $_->[0]) } @STEPS;
    return undef;
}

# The descriptor limit (the soft "Max open files" of /proc/self/limits)
# decides the batch and how deep the walk may hold directories open (fifth
# review D5: read line by line, whatever $/ the caller has).
sub fd_limit {
    my ($path) = @_;
    open(my $l, '<', $path // $LIMITS) or return undef;
    local $/ = "\n";
    while (my $line = <$l>) {
        if ($line =~ /^Max open files\s+(\d+|unlimited)/) {
            close $l;
            return $1 eq 'unlimited' ? 1048576 : $1 + 0;
        }
    }
    close $l;
    return undef;
}

# (depth, batch) for `nroots` roots under the limit read from `path`.
sub depth_budget {
    my ($nroots, $path) = @_;
    my $soft = fd_limit($path) // 1024;
    my $batch = int($soft / 8);
    $batch = BATCH_MAX if $batch > BATCH_MAX;
    $batch = BATCH_MIN if $batch < BATCH_MIN;
    my $depth = $soft - $batch - FD_RESERVE - $nroots;
    $depth = MAX_DEPTH if $depth > MAX_DEPTH;
    return ($depth, $batch, $soft);
}

# The counts add up: every entry met is in exactly one outcome, and per step
# changed + failed = the entries the step applies to.
sub accounted {
    my ($st) = @_;
    my $outcomes = $st->{visited}{files} + $st->{visited}{dirs} + $st->{skipped}{links} + $st->{skipped}{other}
        + $st->{swapped} + $st->{gone} + $st->{boundary} + $st->{nestedRoots} + $st->{unreadable};
    return "met $st->{seen} entries, accounted for $outcomes" if $outcomes != $st->{seen};
    # Sixth review: every meeting that found its entry gone is either still
    # vanished or was met again under another name and acted on there.
    return "gone $st->{gone}, vanished $st->{vanished} + met again $st->{returned}" if $st->{vanished} + $st->{returned} != $st->{gone};
    for my $step (@STEPS) {
        my $k = $step->[0];
        next unless step_enabled($st->{job}, $k);
        my $want = $step->[1] eq 'all' ? $st->{visited}{files} + $st->{visited}{dirs} : $st->{visited}{dirs};
        return "$k: $st->{eligible}{$k} acted on of $want" if $st->{eligible}{$k} != $want;
        return "$k: $st->{changed}{$k} changed + $st->{failed}{$k} failed of $want" if $st->{changed}{$k} + $st->{failed}{$k} != $want;
    }
    return undef;
}

sub result {
    my ($st, %extra) = @_;
    my %out = map { $_ => $st->{$_} } qw(visited changed failed skipped swapped vanished returned boundary boundaries boundariesDropped nestedRoots zfsControl tooDeep notEntered changing overrun notes notesDropped maxDepth);
    $out{errors} = $st->{unreadable} + $st->{notEntered};
    $out{errors} += $st->{failed}{$_} for keys %{ $st->{failed} };
    my $mismatch = accounted($st);
    $out{accounted} = defined $mismatch ? JSON::PP::false : JSON::PP::true;
    $out{accountingError} = $mismatch if defined $mismatch;
    return { %out, %extra };
}

# The report line, never longer than $REPORT_MAX: notes, then boundaries, are
# dropped (and counted) until it fits.
sub encode_report {
    my ($out) = @_;
    my $json = JSON::PP->new->canonical;
    my $text = $json->encode($out);
    while (length($text) > $REPORT_MAX && (@{ $out->{notes} // [] } || @{ $out->{boundaries} // [] })) {
        if (@{ $out->{notes} // [] }) {
            pop @{ $out->{notes} };
            $out->{notesDropped}++;
        }
        else {
            pop @{ $out->{boundaries} };
            $out->{boundariesDropped}++;
        }
        $text = $json->encode($out);
    }
    return $text;
}

sub run {
    my ($stdin_text, %o) = @_;
    my $job = eval { JSON::PP->new->decode($stdin_text) };
    return (2, { refused => 'the job is not JSON' }) unless $job;
    my $bad = validate($job);
    return (2, { refused => $bad }) if $bad;
    my $roots = $job->{roots};
    my ($max_depth, $batch, $soft) = depth_budget(scalar @$roots, $o{limits});
    return (2, { refused => "too few file descriptors for the walk (the limit is $soft)" }) if $max_depth < 2;
    my $why = check_roots($roots);
    return (2, { refused => $why }) if $why;
    my %root_ids = map { ("$_->{dev}:$_->{ino}:$_->{mnt}" => 1) } @$roots;
    my $st = new_state($job, $max_depth, $batch);
    for my $root (@$roots) {
        my $ok = eval { walk_root($st, $root, \%root_ids); 1 };
        if (!$ok) {
            my $err = $@ || 'unknown failure';
            chomp $err;
            eval { flush($st); 1 };
            return (3, result($st, aborted => $err));
        }
    }
    flush($st);
    return (0, result($st, done => JSON::PP::true));
}

sub main {
    my $text = do { local $/; <STDIN> };
    my ($code, $out) = run($text // '');
    print encode_report($out), "\n";
    return $code;
}

exit(main()) unless caller;

1;
