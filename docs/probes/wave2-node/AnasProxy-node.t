#!/usr/bin/perl
#
# Wave-2 node pass, row 1 (cr.27, WAVE2-DESIGN §7 "On the node"): the PVE binding of
# AnasProxy.pm tested against the REAL PVE modules — PVE::HTTPServer::auth_handler,
# PVE::RPCEnvironment (init_request over the live /etc/pve/user.cfg, check),
# PVE::AccessControl's ticket and CSRF verifiers — run as www-data like a pveproxy
# worker, with tickets and CSRF tokens minted at test time by a real /access/ticket
# login (passed in W2_CRED as JSON {user: [ticket, csrf]}). The installed module
# (/usr/share/anas/perl/AnasProxy.pm) is the one under test; the end-to-end cases
# forward through the real gateway with the real /run/anas/proxy.key.
#
# Rows of §8 covered: 3 (anas-audit), 4 (anas-none), 5 (anas-np, propagate 0),
# 6 (anas-node, /nodes only), 7 (anas-gm, group grant), 8 (anas-off, disabled by the
# wrapper before this runs), plus the §7 mutation case "pass undef as the CSRF token
# to auth_handler" and a foreign CSRF token.
#
#   sudo -u www-data env W2_CRED='…' prove -v AnasProxy-node.t      (r1-prove-node.sh)

use strict;
use warnings;
use Test::More;
use JSON::PP ();
use HTTP::Headers ();
use HTTP::Request ();
use URI ();
use Time::HiRes ();
use AnyEvent ();

use lib '/usr/share/anas/perl';
use PVE::HTTPServer ();
use PVE::RPCEnvironment ();
require AnasProxy;

my $cred = JSON::PP::decode_json($ENV{W2_CRED} // die "W2_CRED missing\n");
cmp_ok($>, '!=', 0, "running as uid $> (not root: auth_handler skips CSRF for euid 0)");
is($INC{'AnasProxy.pm'}, '/usr/share/anas/perl/AnasProxy.pm', 'the installed AnasProxy.pm is under test');
ok(defined &PVE::HTTPServer::auth_handler, 'real PVE::HTTPServer::auth_handler loaded from ' . $INC{'PVE/HTTPServer.pm'});

my (@LOGS, @RESP, $cv);
$AnasProxy::LOG = sub { push @LOGS, $_[0] };
$AnasProxy::UNAUTH_DELAY = 0;

{   # A server object with PVE's own class and auth_handler; response() is the only
    # thing replaced (it would write to a client socket).
    package W2Server;
    our @ISA = ('PVE::HTTPServer');
    sub response { my ($self, $reqstate, $resp) = @_; push @RESP, $resp; $cv->send if $cv; }
}
my $server = bless {
    rpcenv => PVE::RPCEnvironment->init('pub'),
    cookie_name => 'PVEAuthCookie', apitoken_name => 'PVEAPIToken',
}, 'W2Server';

sub headers_for {
    my ($user, $csrf_user) = @_;
    my $h = HTTP::Headers->new;
    $h->header(Cookie => "PVEAuthCookie=$cred->{$user}[0]") if $user;
    $h->header(CSRFPreventionToken => $cred->{$csrf_user}[1]) if $csrf_user;
    return $h;
}
sub authorize {
    my ($user, $method, $target, $csrf_user) = @_;
    my $reqstate = { peer_host => '127.0.0.1', log => {} };
    return AnasProxy::_authorize($server, $reqstate, $method, $target, headers_for($user, $csrf_user));
}
# The whole handler, through AnyEvent::HTTP to the real gateway with the real key.
sub through {
    my ($user, $method, $target, $csrf_user) = @_;
    @RESP = (); @LOGS = (); $cv = AnyEvent->condvar;
    my $uri = URI->new("/anas$target");
    my $req = HTTP::Request->new($method, $uri, headers_for($user, $csrf_user));
    my $reqstate = { peer_host => '127.0.0.1', log => {}, request => $req };
    AnasProxy::handle($server, $reqstate, $method, $uri);
    my $t = AnyEvent->timer(after => 20, cb => sub { $cv->send });
    $cv->recv; undef $cv;
    my $r = $RESP[0];
    my $body = eval { JSON::PP::decode_json($r->content) } // {};
    return { code => $r ? $r->code : 0, body => $body, logs => [@LOGS], userid => $reqstate->{log}{userid} };
}
my $P = '/api/nodes/anas-pve/v1';

# --- privileges, as PVE compiles them -----------------------------------------
my %want = (
    'root@pam'       => 'Sys.Audit,Sys.Modify',
    'anas-admin@pve' => 'Sys.Audit,Sys.Modify',
    'anas-audit@pve' => 'Sys.Audit',                # row 3
    'anas-none@pve'  => '',                         # row 4
    'anas-np@pve'    => 'Sys.Audit,Sys.Modify',     # row 5: propagate 0 → value 0, still DEFINED
    'anas-node@pve'  => '',                         # row 6: /nodes/anas-pve only
    'anas-gm@pve'    => 'Sys.Audit',                # row 7: through group anas-g
);
for my $u (sort keys %want) {
    my $d = authorize($u, 'GET', "$P/pools");
    ok(!$d->{refuse}, "$u: authenticated by PVE") or diag explain $d->{refuse};
    is(join(',', @{ $d->{privs} || [] }), $want{$u}, "$u: PVE grants [$want{$u}] on /");
    is($d->{userid}, $u, "$u: user id from auth_handler");
}

# --- row 8: the disabled user (the wrapper ran `pveum user modify anas-off@pve --enable 0`)
{
    my $d = authorize('anas-off@pve', 'GET', "$P/pools");
    is($d->{refuse}{status}, 401, 'row 8 anas-off (disabled): 401');
    is($d->{refuse}{message}, 'Authentication failed!', 'row 8: PVE\'s sentence');
    is($d->{refuse}{reason}, 'authentication failed', 'row 8: logged reason');
}

# --- CSRF: the real verifier, as www-data ------------------------------------------
{
    my $d = authorize('anas-admin@pve', 'POST', "$P/pools/w2nosuch/scrub", 'anas-admin@pve');
    ok(!$d->{refuse}, 'POST with its own CSRF token: passes');
    $d = authorize('anas-admin@pve', 'POST', "$P/pools/w2nosuch/scrub", undef);
    is($d->{refuse}{reason}, 'invalid csrf token', 'POST without a token: invalid csrf token');
    is($d->{userid}, 'anas-admin@pve', 'a token refusal still names the user');
    $d = authorize('anas-admin@pve', 'POST', "$P/pools/w2nosuch/scrub", 'root@pam');
    is($d->{refuse}{reason}, 'invalid csrf token', 'POST with root@pam\'s token: invalid csrf token (bound to the user)');
    # §7 mutation: auth_handler itself, given undef as the CSRF token, must die.
    my $r = eval { $server->auth_handler('POST', '/anas/x', $cred->{'anas-admin@pve'}[0], undef, undef, '127.0.0.1'); 1 };
    like("$@", qr/invalid csrf token/, 'auth_handler(POST, csrf undef) as www-data dies "invalid csrf token"');
    ok(!$r, '… and returns nothing');
    $r = eval { $server->auth_handler('GET', '/anas/x', $cred->{'anas-admin@pve'}[0], undef, undef, '127.0.0.1') };
    is(ref($r) && $r->{userid}, 'anas-admin@pve', 'auth_handler(GET, csrf undef) passes (GET needs no token, as PVE)');
}

# --- end to end through the real gateway (rows 3-7) ----------------------------------
my @e2e = (
    # user,            method, target,                         csrf,             expected
    ['anas-audit@pve', 'GET',  "$P/pools",                     undef,            200],
    ['anas-audit@pve', 'POST', "$P/pools/w2nosuch/scrub",      'anas-audit@pve', 403],
    ['anas-none@pve',  'GET',  "$P/health",                    undef,            403],
    ['anas-np@pve',    'GET',  "$P/pools",                     undef,            200],
    ['anas-np@pve',    'POST', "$P/pools/w2nosuch/scrub",      'anas-np@pve',    404],  # past authz: the daemon's own 404
    ['anas-node@pve',  'GET',  "$P/pools",                     undef,            403],
    ['anas-gm@pve',    'GET',  "$P/pools",                     undef,            200],
    ['anas-gm@pve',    'POST', "$P/pools/w2nosuch/scrub",      'anas-gm@pve',    403],
    ['root@pam',       'GET',  "$P/shares/nfs/%2Ftestpool%2Fshare1?w2=a%2Fb", undef, 200],
);
for my $c (@e2e) {
    my ($u, $m, $t, $cs, $want) = @$c;
    my $r = through($u, $m, $t, $cs);
    is($r->{code}, $want, "e2e $u $m $t → $want") or diag explain $r;
    like($r->{body}{error}{message} // '', qr/^Permission check failed \(\/, Sys\.(Audit|Modify)\): \Q$u\E does not have it/,
        "   the 403 names the privilege and $u") if $want == 403;
    is($r->{userid}, $u, "   access-log user id set to $u");
}

# --- row 14: what the hand-off adds per request, in process ------------------------------
{
    my @t;
    for (1 .. 50) {
        my $t0 = Time::HiRes::time();
        my $d = authorize('anas-admin@pve', 'GET', "$P/pools");
        my ($key) = AnasProxy::_read_key();
        my $a = AnasProxy::_assertion($key, $d->{userid}, $d->{privs}, time(), 'GET', "$P/pools");
        push @t, (Time::HiRes::time() - $t0) * 1000;
    }
    @t = sort { $a <=> $b } @t;
    my $med = ($t[24] + $t[25]) / 2;
    diag(sprintf('row 14: auth_handler + 2 x check + key read + HMAC, 50 runs: min %.3f median %.3f max %.3f ms', $t[0], $med, $t[-1]));
    cmp_ok($med, '<=', 2, 'row 14: median added work ≤ 2 ms');
}

done_testing();
