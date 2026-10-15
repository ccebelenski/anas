#!/usr/bin/perl
#
# cr.27 — PVE decides who and what inside pveproxy (docs/WAVE2-DESIGN.md §2
# A2, A2.1, A2.2, A5; §5 rows 1-8; §7). Tests the pure helpers and the handler
# end to end against a fake pveproxy server object.
#
# The fakes are transliterations of PVE's own code, quoted in the probes, not
# behaviour the author made up:
#   - FakeServer::auth_handler   HTTPServer.pm:54-141     (docs/probes/wave2/01)
#   - FakeRPCEnv::check          RPCEnvironment.pm:291-305 (probe 01): a privilege
#                                is granted when its key is DEFINED (:121-131)
#   - FakeRPCEnv::permissions    root@pam "can do anything" (:136-140)
#   - CSRF tokens                Ticket.pm:19-50 / AccessControl.pm:343-361 (probe 03):
#                                bound to the user id, "Permission denied - invalid
#                                csrf token\n", code 401
#   - verify_ticket vs a missing user: the signature passes, check_user_enabled
#                                refuses (probe 04, "no such user ('...')")
# The permission maps have the shape of `GET /access/permissions` (privilege →
# propagate flag; AccessControl API, probe 02). They are written here because
# the per-user captures of §7 are owed by the node pass that creates the test
# users; the propagate-0 map is the case that catches an `== 1` comparison.
#
#   prove -I packages/pve-integration/perl packages/pve-integration/perl/t

use strict;
use warnings;
no warnings 'once';
use FindBin;
use lib "$FindBin::Bin/..";
use Test::More;
use Digest::SHA ();
use File::Temp ();
use HTTP::Headers ();
use HTTP::Request ();
use JSON::PP ();
use URI ();

# --- fake AnyEvent / AnyEvent::HTTP (CI has neither; the handler requires them
#     lazily, so registering them in %INC satisfies the require) --------------
our (@HTTP_CALLS, @TIMERS);
BEGIN {
    $INC{'AnyEvent.pm'} = __FILE__;
    $INC{'AnyEvent/HTTP.pm'} = __FILE__;
}
{
    no warnings 'once';
    *AnyEvent::HTTP::http_request = sub {
        my $cb = pop @_;
        my ($method, $url, %args) = @_;
        push @HTTP_CALLS, { method => $method, url => $url, headers => $args{headers},
            body => $args{body}, cb => $cb };
        return 'guard';
    };
    *AnyEvent::timer = sub {
        my ($class, %args) = @_;
        push @TIMERS, \%args;
        return 'timer-guard';
    };
}

require_ok('AnasProxy.pm');

# --- PVE::Exception, as raise() builds it ------------------------------------
{
    package PVE::Exception;
    use overload '""' => sub { $_[0]->{msg} }, fallback => 1;
    sub new { my ($class, $msg, %param) = @_; return bless { msg => $msg, %param }, $class; }
    sub raise { die PVE::Exception->new(@_); }
}

# --- the fake RPC environment --------------------------------------------------
my %PERMS = (
    # user id => { acl path => { privilege => propagate } }
    'root@pam'        => 'ROOT',
    'anas-admin@pve'  => { '/' => { 'Sys.Audit' => 1, 'Sys.Modify' => 1, 'Datastore.Allocate' => 1 } },
    'anas-audit@pve'  => { '/' => { 'Sys.Audit' => 1, 'Datastore.Audit' => 1 } },
    'anas-gm@pve'     => { '/' => { 'Sys.Audit' => 1 } },                     # via group anas-g
    'anas-np@pve'     => { '/' => { 'Sys.Audit' => 0, 'Sys.Modify' => 0 } }, # --propagate 0
    'anas-node@pve'   => { '/nodes/anas-pve' => { 'Sys.Audit' => 1, 'Sys.Modify' => 1 } },
    'anas-none@pve'   => {},
);
my %USERS = (   # user.cfg: enabled flag (a missing key = no such user)
    map({ $_ => 1 } keys %PERMS),
    'anas-off@pve' => 0,
);
{
    package FakeRPCEnv;
    sub new { my ($class, %a) = @_; return bless { %a }, $class; }
    sub set_user { $_[0]->{user} = $_[1]; }
    sub get_user { my ($self, $noerr) = @_; return $self->{user} if defined($self->{user}) || $noerr; die "user name not set\n"; }
    sub set_language {}
    sub set_client_ip {}
    sub set_u2f_challenge {}
    sub init_request { my ($self) = @_; die "pmxcfs down\n" if $self->{init_fails}; return; }
    sub check_user_enabled {
        my ($self, $user) = @_;
        die "no such user ('$user')\n" if !exists $USERS{$user};
        die "user '$user' is disabled\n" if !$USERS{$user};
        return 1;
    }
    sub permissions {
        my ($self, $user, $path) = @_;
        my $p = $PERMS{$user};
        return { map { $_ => 1 } qw(Sys.Audit Sys.Modify Datastore.Allocate) } if defined($p) && $p eq 'ROOT';
        return { %{ ($p || {})->{$path} || {} } };
    }
    # RPCEnvironment.pm:291-305, verbatim in substance.
    sub check {
        my ($self, $user, $path, $privs, $noerr) = @_;
        my $perm = $self->permissions($user, $path);
        foreach my $priv (@$privs) {
            if (!defined($perm->{$priv})) {
                return undef if $noerr;
                PVE::Exception::raise("Permission check failed ($path, $priv)\n", code => 403);
            }
        }
        return 1;
    }
}

# --- the fake pveproxy server ---------------------------------------------------
# Tickets: "PVE:<user>:<ts>::<sig>"; "valid" when sig eq 'good'. A signature is
# not a user (F4): a well-signed ticket for a missing user reaches
# check_user_enabled, which refuses it.
sub fake_verify_ticket {
    my ($ticket) = @_;
    die "invalid ticket\n" if $ticket !~ /^PVE:([^:]+):[0-9A-F]{8}::(\S+)$/;
    my ($user, $sig) = ($1, $2);
    die "invalid ticket signature\n" if $sig ne 'good';
    return ($user, 0, undef);
}
sub csrf_for { my ($user) = @_; return '6AD0605A:' . Digest::SHA::sha256_base64("csrf:$user"); }
sub fake_verify_csrf {
    my ($user, $token) = @_;
    return 1 if defined($token) && $token eq csrf_for($user);
    PVE::Exception::raise("Permission denied - invalid csrf token\n", code => 401);
}
{
    package FakeServer;
    our @RESPONSES;
    sub new { my ($class, %a) = @_; return bless { cookie_name => 'PVEAuthCookie',
        apitoken_name => 'PVEAPIToken', rpcenv => FakeRPCEnv->new, %a }, $class; }
    sub response { my ($self, $reqstate, $resp) = @_; push @RESPONSES, $resp; }
    # HTTPServer.pm:54-141 (probe 01), the branches a /anas path reaches.
    sub auth_handler {
        my ($self, $method, $rel_uri, $ticket, $token, $api_token, $peer_host) = @_;
        $self->{last_auth} = [ $method, $rel_uri, $ticket, $token, $api_token, $peer_host ];
        my $rpcenv = $self->{rpcenv};
        $rpcenv->set_user(undef);
        eval { $rpcenv->init_request() };
        PVE::Exception::raise("RPCEnvironment init request failed: $@\n") if $@;
        my ($username, $age);
        die "No ticket\n" if !$ticket;
        eval {
            ($username, $age) = main::fake_verify_ticket($ticket);
            $rpcenv->check_user_enabled($username);
        };
        if (my $err = $@) {
            die "Authentication failed!\n";
        }
        $rpcenv->set_user($username);
        if ($method ne 'GET' && !$api_token) {
            main::fake_verify_csrf($username, $token) if ($self->{euid} // 33) != 0;
        }
        return { ticket => $ticket, token => $token, userid => $username, age => $age,
            isUpload => 0, api_token => $api_token };
    }
}

# --- helpers --------------------------------------------------------------------
my $KEYDIR = File::Temp->newdir;
my $KEY = join('', map { chr } 0 .. 31);
sub write_key {
    my ($path, $bytes) = @_;
    open(my $fh, '>:raw', "$path.tmp") or die $!;
    print $fh $bytes;
    close $fh;
    rename("$path.tmp", $path) or die $!;
}
write_key("$KEYDIR/proxy.key", $KEY);

my @LOGS;
$AnasProxy::LOG = sub { push @LOGS, $_[0] };
$AnasProxy::KEY_FILE = "$KEYDIR/proxy.key";
$AnasProxy::GATEWAY = 'http://127.0.0.1:3000';
$AnasProxy::EUID = 33;                      # a pveproxy worker (www-data)
$AnasProxy::UNAUTH_DELAY = 0;
$AnasProxy::EXTRACT_AUTH = sub {
    # Stand-in for PVE::APIServer::Formatter::extract_auth_value: `<name>=<value>`
    # inside a cookie or Authorization header. The binding passes PVE's own.
    my ($header, $name) = @_;
    return undef if !defined $header;
    return $header =~ /(?:^|[;\s])\Q$name\E[=:]([^;]*)/ ? $1 : undef;
};

sub ticket { my ($user) = @_; return "PVE:$user:6AD0605A::good"; }

# Run one request through AnasProxy::handle; returns { response | call, log }.
sub run {
    my (%a) = @_;
    my $server = $a{server} || FakeServer->new;
    my $h = HTTP::Headers->new;
    $h->header(Cookie => 'PVEAuthCookie=' . ticket($a{user})) if $a{user};
    $h->header(Cookie => $a{cookie}) if $a{cookie};
    $h->header(Authorization => $a{authorization}) if $a{authorization};
    $h->header(CSRFPreventionToken => $a{csrf}) if defined $a{csrf};
    for my $k (keys %{ $a{headers} || {} }) { $h->header($k => $a{headers}{$k}); }
    my $uri = URI->new($a{path} || '/anas/api/nodes/anas-pve/v1/pools');
    my $req = HTTP::Request->new($a{method} || 'GET', $uri, $h, $a{body});
    my $reqstate = { request => $req, peer_host => '192.0.2.7', log => {} };
    @HTTP_CALLS = (); @FakeServer::RESPONSES = (); @LOGS = (); @TIMERS = ();
    AnasProxy::handle($server, $reqstate, $a{method} || 'GET', $uri);
    my $resp = $FakeServer::RESPONSES[0];
    return {
        server   => $server,
        reqstate => $reqstate,
        call     => $HTTP_CALLS[0],
        calls    => scalar(@HTTP_CALLS),
        resp     => $resp,
        body     => ($resp ? JSON::PP->new->decode($resp->content) : undef),
        logs     => [ @LOGS ],
    };
}

# Verify an X-Anas-Auth value the way the gateway does (the gateway's own
# tests check its verifier against the shared vectors in t/fixtures).
sub parse_assertion {
    my ($v) = @_;
    return undef if !defined($v) || $v !~ /^v1;user=([^;]*);privs=([^;]*);ts=(\d+);mac=([0-9a-f]{64})$/;
    return { user => $1, privs => $2, ts => $3, mac => $4 };
}
sub assertion_ok {
    my ($v, $method, $target) = @_;
    my $p = parse_assertion($v) or return 0;
    my $want = Digest::SHA::hmac_sha256_hex(
        join("\n", 'v1', $p->{user}, $p->{privs}, $p->{ts}, $method, $target), $KEY);
    return $want eq $p->{mac};
}

# ============================================================================
# Pure helpers
# ============================================================================

# --- _outside_pveproxy (A2.2, F10) ---------------------------------------------
is(AnasProxy::_outside_pveproxy({ trusted_env => 1 }, 0), 'served outside pveproxy (trusted_env)',
    'pvedaemon (trusted_env) is outside pveproxy');
is(AnasProxy::_outside_pveproxy({}, 0), 'served outside pveproxy (euid 0)',
    'any root server is outside pveproxy (auth_handler skips CSRF at euid 0)');
is(AnasProxy::_outside_pveproxy({}, 33), undef, 'a www-data pveproxy worker serves ANAS');

# --- _exempt: the presence probe only ----------------------------------------------
ok(AnasProxy::_exempt('GET', '/installed'), 'GET /installed is the exemption');
ok(AnasProxy::_exempt('GET', '/installed?x=1'), 'GET /installed with a query is the exemption');
ok(!AnasProxy::_exempt('POST', '/installed'), 'POST /installed is not exempt');
ok(!AnasProxy::_exempt('HEAD', '/installed'), 'HEAD /installed is not exempt (the gateway exempts GET only)');
ok(!AnasProxy::_exempt('GET', '/api/health'), 'GET /api/health is not exempt');
ok(!AnasProxy::_exempt('GET', '/installed/x'), 'a path under /installed is not exempt');

# --- _forward_target -----------------------------------------------------------------
is(AnasProxy::_forward_target(URI->new('/anas/api/nodes/n/v1/pools?a=1')),
    '/api/nodes/n/v1/pools?a=1', 'forward target keeps the query, drops /anas');
is(AnasProxy::_forward_target(URI->new('/anas/api/nodes/n/v1/shares/nfs/%2Ftank')),
    '/api/nodes/n/v1/shares/nfs/%2Ftank', 'forward target keeps percent-encoding');
is(AnasProxy::_forward_target(URI->new('/anas')), '/', 'bare /anas targets /');

# --- _request_headers drops a client-supplied X-Anas-Auth --------------------------
{
    my $h = HTTP::Headers->new;
    $h->header('X-Anas-Auth' => 'v1;user=root@pam;privs=Sys.Audit,Sys.Modify;ts=1;mac=00');
    $h->header('x-anas-auth' => 'forged-lowercase');
    $h->header('Cookie' => 'PVEAuthCookie=abc');
    my $out = AnasProxy::_request_headers($h);
    ok(!grep({ lc($_) eq 'x-anas-auth' } keys %$out), 'client-supplied X-Anas-Auth never forwarded');
    is($out->{Cookie}, 'PVEAuthCookie=abc', 'other headers still forwarded');
}

# --- _credentials: where PVE looks for them (AnyEvent.pm:1591-1611) -----------------
{
    my $ex = $AnasProxy::EXTRACT_AUTH;
    my $h = HTTP::Headers->new(Cookie => 'PVEAuthCookie=T1', CSRFPreventionToken => 'C1');
    my $c = AnasProxy::_credentials($h, 'PVEAuthCookie', 'PVEAPIToken', $ex);
    is($c->{ticket}, 'T1', 'ticket from the cookie');
    is($c->{csrf}, 'C1', 'CSRF token from its header');
    ok(!$c->{forwarded}, 'not a forwarded request');

    $h = HTTP::Headers->new(Authorization => 'PVEAuthCookie=T2');
    is(AnasProxy::_credentials($h, 'PVEAuthCookie', 'PVEAPIToken', $ex)->{ticket}, 'T2',
        'ticket from the Authorization header fallback');

    $h = HTTP::Headers->new(Authorization => 'PVEAPIToken=root@pam!t=uuid');
    $c = AnasProxy::_credentials($h, 'PVEAuthCookie', 'PVEAPIToken', $ex);
    ok(!$c->{ticket}, 'an API token is not a ticket');
    is($c->{api_token}, 'root@pam!t=uuid', 'API token found when there is no ticket');

    $h = HTTP::Headers->new(Cookie => 'PVEAuthCookie=T3', Authorization => 'PVEAPIToken=x', 'X-Anas-Forwarded' => '1');
    $c = AnasProxy::_credentials($h, 'PVEAuthCookie', 'PVEAPIToken', $ex);
    is($c->{ticket}, 'T3', 'a ticket wins over an API token (as PVE)');
    ok(!$c->{api_token}, 'the token is not even read when a ticket is present');
    ok($c->{forwarded}, 'X-Anas-Forwarded noticed');
}

# --- _auth_refusal: each die auth_handler can raise ---------------------------------
{
    my $r = AnasProxy::_auth_refusal("No ticket\n", {});
    is_deeply([ @$r{qw(status code message reason)} ],
        [ 401, 'UNAUTHORIZED', 'Access ANAS through the Proxmox UI', 'no ticket' ], 'No ticket → 401');
    ok($r->{delay}, 'a 401 is delayed (as PVE)');

    $r = AnasProxy::_auth_refusal("Authentication failed!\n", {});
    is_deeply([ @$r{qw(status message reason)} ], [ 401, 'Authentication failed!', 'authentication failed' ],
        'Authentication failed! → 401 with PVE\'s message');

    my $csrf = PVE::Exception->new("Permission denied - invalid csrf token\n", code => 401);
    $r = AnasProxy::_auth_refusal($csrf, { csrf => 'x' });
    is_deeply([ @$r{qw(status message reason)} ],
        [ 401, 'Permission denied - invalid csrf token', 'invalid csrf token' ], 'invalid CSRF → 401 with PVE\'s wording');

    $r = AnasProxy::_auth_refusal($csrf, { forwarded => 1, csrf => undef });
    like($r->{message}, qr/forwarded without a CSRF token: the forwarding node's ANAS is older than this one/,
        'a forwarded request without a token names the older peer');
    is($r->{reason}, 'invalid csrf token (forwarded without one)', 'and logs it');

    $r = AnasProxy::_auth_refusal($csrf, { forwarded => 1, csrf => 'bad' });
    is($r->{message}, 'Permission denied - invalid csrf token', 'a forwarded request WITH a bad token is just invalid');

    my $init = PVE::Exception->new("RPCEnvironment init request failed: Unable to load access control list: pmxcfs down\n");
    $r = AnasProxy::_auth_refusal($init, {});
    is_deeply([ @$r{qw(status code message)} ],
        [ 503, 'UNAVAILABLE', 'PVE access control unavailable: Unable to load access control list: pmxcfs down' ],
        'init_request failure → 503 naming the error');
    ok(!$r->{delay}, 'a 503 is not delayed');

    $r = AnasProxy::_auth_refusal("something new\n", {});
    is($r->{status}, 401, 'an unknown die fails closed as a 401');
    is($r->{reason}, 'auth_handler: something new', 'and logs PVE\'s message');
}

# --- _granted: PVE's definedness rule over the permission maps ---------------------
{
    my $env = FakeRPCEnv->new;
    my $check = sub { $env->check(@_) };
    is_deeply(AnasProxy::_granted($check, 'root@pam'), [ 'Sys.Audit', 'Sys.Modify' ], 'root@pam: both');
    is_deeply(AnasProxy::_granted($check, 'anas-admin@pve'), [ 'Sys.Audit', 'Sys.Modify' ], 'Administrator on /: both');
    is_deeply(AnasProxy::_granted($check, 'anas-audit@pve'), [ 'Sys.Audit' ], 'PVEAuditor on /: Sys.Audit only');
    is_deeply(AnasProxy::_granted($check, 'anas-gm@pve'), [ 'Sys.Audit' ], 'group grant: Sys.Audit only');
    is_deeply(AnasProxy::_granted($check, 'anas-np@pve'), [ 'Sys.Audit', 'Sys.Modify' ],
        'propagate 0 (value 0) is GRANTED: definedness, not == 1 (F7)');
    is_deeply(AnasProxy::_granted($check, 'anas-node@pve'), [], 'a /nodes/<n>-only grant gives nothing on /');
    is_deeply(AnasProxy::_granted($check, 'anas-none@pve'), [], 'no ACL: nothing');
}

# --- _assertion: the shared known-answer vectors -----------------------------------
{
    my $file = "$FindBin::Bin/fixtures/assertion-vectors.json";
    open(my $fh, '<', $file) or die "$file: $!";
    my $doc = JSON::PP->new->decode(do { local $/; <$fh> });
    close $fh;
    my $key = pack('H*', $doc->{key_hex});
    for my $v (@{ $doc->{vectors} }) {
        my $user = pack('H*', $v->{userid_bytes_hex});
        is(AnasProxy::_assertion($key, $user, $v->{privileges}, $v->{ts}, $v->{method}, $v->{path}),
            $v->{header}, "known-answer vector: $v->{method} $v->{path}");
    }
    like(AnasProxy::_assertion($KEY, 'a;b=c,d@pve', [], 1, 'GET', '/'), qr/^v1;user=a%3Bb%3Dc%2Cd\@pve;privs=;ts=1;mac=[0-9a-f]{64}$/,
        'a user id with ; = , is percent-encoded and cannot split the header');
}

# --- _read_key -----------------------------------------------------------------------
{
    my $dir = File::Temp->newdir;
    my ($k, $why) = AnasProxy::_read_key("$dir/none");
    ok(!defined $k, 'a missing key reads as undef');
    like($why, qr/^proxy key unreadable: \Q$dir\E\/none: /, 'and names the file and errno');

    write_key("$dir/short", 'x' x 8);
    ($k, $why) = AnasProxy::_read_key("$dir/short");
    like($why, qr/shorter than 32 bytes/, 'a truncated key is refused');

    write_key("$dir/k", 'A' x 32);
    is((AnasProxy::_read_key("$dir/k"))[0], 'A' x 32, 'a key is read');
    write_key("$dir/k", 'B' x 32);   # a gateway restart renames a new file into place
    is((AnasProxy::_read_key("$dir/k"))[0], 'B' x 32, 'a rotated key (new inode) is re-read, not served from the cache');
}

# --- _envelope: the ANAS error body, ASCII-safe whatever PVE's error says -----
{
    my $r = AnasProxy::_envelope(503, 'UNAVAILABLE', "pmxcfs: \x{263a} caf\x{e9}");
    is($r->code, 503, 'envelope status');
    is($r->header('Content-Type'), 'application/json', 'envelope content type');
    is($r->content, '{"error":{"code":"UNAVAILABLE","message":"pmxcfs: ' . chr(92) . 'u263a caf' . chr(92) . 'u00e9"}}',
        'non-ASCII is escaped, never a wide character in the body');
}

# ============================================================================
# The handler, end to end against the fake pveproxy
# ============================================================================

# Row 1: inside pvedaemon (trusted_env) — 404, logged, nothing forwarded.
{
    my $r = run(server => FakeServer->new(trusted_env => 1), path => '/anas/installed');
    is($r->{resp}->code, 404, 'pvedaemon: 404 even for the presence probe');
    is($r->{body}{error}{message}, 'ANAS is served through pveproxy on :8006 only', 'pvedaemon: the sentence');
    is($r->{calls}, 0, 'pvedaemon: nothing forwarded');
    like($r->{logs}[0], qr/^anas-proxy: refused GET \/installed from 192\.0\.2\.7: served outside pveproxy \(trusted_env\)$/,
        'pvedaemon: logged with the reason');
}
{
    local $AnasProxy::EUID = 0;
    my $r = run(user => 'root@pam');
    is($r->{resp}->code, 404, 'euid 0: 404');
    like($r->{logs}[0], qr/served outside pveproxy \(euid 0\)/, 'euid 0: logged');
}

# The presence probe: forwarded without asking PVE, any forged assertion stripped.
{
    my $r = run(path => '/anas/installed', headers => { 'X-Anas-Auth' => 'v1;forged' });
    is($r->{calls}, 1, 'GET /anas/installed forwarded without a ticket');
    is($r->{call}{url}, 'http://127.0.0.1:3000/installed', 'to the gateway\'s /installed');
    ok(!grep({ lc($_) eq 'x-anas-auth' } keys %{ $r->{call}{headers} }), 'no assertion on the exempt probe, the forged one stripped');
    ok(!$r->{server}{last_auth}, 'auth_handler not called for the probe');
}

# Row 2: no ticket.
{
    my $r = run();
    is($r->{resp}->code, 401, 'no ticket: 401');
    is($r->{body}{error}{message}, 'Access ANAS through the Proxmox UI', 'no ticket: the sentence');
    is($r->{body}{error}{code}, 'UNAUTHORIZED', 'no ticket: the code');
    like($r->{logs}[0], qr/refused GET \/api\/nodes\/anas-pve\/v1\/pools from 192\.0\.2\.7: no ticket$/, 'no ticket: logged');
    is($r->{calls}, 0, 'no ticket: nothing forwarded');
}
# PVE's 3 s delay on a 401.
{
    local $AnasProxy::UNAUTH_DELAY = 3;
    my $r = run();
    ok(!$r->{resp}, 'with the delay on, nothing is answered at once');
    is(scalar(@TIMERS), 1, 'one timer armed');
    is($TIMERS[0]{after}, 3, 'for 3 seconds');
    ok($r->{reqstate}{anas_proxy_delay}, 'its guard parked on the reqstate');
    $TIMERS[0]{cb}->();
    is($FakeServer::RESPONSES[0]->code, 401, 'the timer answers the 401');
    ok(!$r->{reqstate}{anas_proxy_delay}, 'and releases the guard');
}

# Row 3: an API token.
{
    my $r = run(authorization => 'PVEAPIToken=root@pam!ci=0000');
    is($r->{resp}->code, 401, 'API token: 401');
    is($r->{body}{error}{message}, 'PVE API tokens are not accepted by ANAS', 'API token: the sentence');
    like($r->{logs}[0], qr/: API token presented$/, 'API token: logged');
}

# Row 4: auth_handler refuses the ticket / the user.
{
    my $r = run(cookie => 'PVEAuthCookie=PVE:root@pam:6AD0605A::forged');
    is($r->{resp}->code, 401, 'a forged ticket: 401');
    is($r->{body}{error}{message}, 'Authentication failed!', 'a forged ticket: PVE\'s message');
    like($r->{logs}[0], qr/: authentication failed$/, 'a forged ticket: logged');

    $r = run(user => 'anas-off@pve');
    is($r->{resp}->code, 401, 'a disabled user with a well-signed ticket: 401 (check_user_enabled, F4)');
    $r = run(user => 'ghost@pve');
    is($r->{resp}->code, 401, 'a deleted user with a well-signed ticket: 401');
    is($r->{calls}, 0, 'nothing forwarded for a refused user');
}

# Row 5: CSRF on mutations, never on GET.
{
    my $r = run(method => 'POST', user => 'root@pam', path => '/anas/api/nodes/anas-pve/v1/pools/tank/scrub');
    is($r->{resp}->code, 401, 'POST without a CSRF token: 401');
    is($r->{body}{error}{message}, 'Permission denied - invalid csrf token', 'POST without a token: PVE\'s wording');
    like($r->{logs}[0], qr/refused POST \/api\/nodes\/anas-pve\/v1\/pools\/tank\/scrub from 192\.0\.2\.7 \(root\@pam\): invalid csrf token$/,
        'POST without a token: logged');

    $r = run(method => 'POST', user => 'root@pam', csrf => csrf_for('anas-admin@pve'));
    is($r->{resp}->code, 401, 'POST with another user\'s CSRF token: 401');

    $r = run(method => 'DELETE', user => 'root@pam', headers => { 'X-Anas-Forwarded' => '1' });
    like($r->{body}{error}{message}, qr/forwarding node's ANAS is older/, 'a forwarded mutation without a token names the older peer');

    $r = run(method => 'HEAD', user => 'root@pam');
    is($r->{resp}->code, 401, 'HEAD needs the token too (PVE checks every method but GET)');

    $r = run(method => 'GET', user => 'root@pam');
    is($r->{calls}, 1, 'GET without a token is forwarded (PVE never checks CSRF on GET)');
}

# Row 6: PVE access control unavailable.
{
    my $r = run(server => FakeServer->new(rpcenv => FakeRPCEnv->new(init_fails => 1)), user => 'root@pam');
    is($r->{resp}->code, 503, 'init_request failing: 503');
    like($r->{body}{error}{message}, qr/^PVE access control unavailable: pmxcfs down/, 'init_request failing: names the error');
    like($r->{logs}[0], qr/RPCEnvironment init request failed: pmxcfs down/, 'init_request failing: logged');
}

# The authenticated paths: what reaches the gateway.
{
    my $r = run(user => 'root@pam', path => '/anas/api/nodes/anas-pve/v1/pools?x=1',
        headers => { 'X-Anas-Auth' => 'v1;user=root@pam;privs=Sys.Audit,Sys.Modify;ts=1;mac=' . ('0' x 64) });
    is($r->{calls}, 1, 'root GET forwarded');
    is($r->{call}{url}, 'http://127.0.0.1:3000/api/nodes/anas-pve/v1/pools?x=1', 'to the forward target');
    my $a = $r->{call}{headers}{'X-Anas-Auth'};
    ok(assertion_ok($a, 'GET', '/api/nodes/anas-pve/v1/pools?x=1'), 'carries a valid assertion (the forged one replaced)');
    is(scalar(grep { lc($_) eq 'x-anas-auth' } keys %{ $r->{call}{headers} }), 1, 'exactly one X-Anas-Auth');
    my $p = parse_assertion($a);
    is($p->{user}, 'root@pam', 'assertion: the user with its realm');
    is($p->{privs}, 'Sys.Audit,Sys.Modify', 'assertion: both privileges');
    ok(abs($p->{ts} - time()) <= 2, 'assertion: a fresh timestamp');
    is($r->{reqstate}{log}{userid}, 'root@pam', 'the access log names the user (F1)');
    is_deeply([ @{ $r->{server}{last_auth} }[0, 1, 4, 5] ], [ 'GET', '/anas/api/nodes/anas-pve/v1/pools', undef, '192.0.2.7' ],
        'auth_handler called as pveproxy calls it: method, path (no query), no API token, peer');
    is(scalar(@{ $r->{logs} }), 0, 'nothing logged on success');
}
{
    my $r = run(method => 'POST', user => 'anas-audit@pve', csrf => csrf_for('anas-audit@pve'),
        path => '/anas/api/nodes/anas-pve/v1/pools/tank/scrub', body => '{}');
    is($r->{calls}, 1, 'an auditor\'s POST reaches the gateway (the gateway decides the 403)');
    my $p = parse_assertion($r->{call}{headers}{'X-Anas-Auth'});
    is($p->{privs}, 'Sys.Audit', 'assertion: Sys.Audit only');
    ok(assertion_ok($r->{call}{headers}{'X-Anas-Auth'}, 'POST', '/api/nodes/anas-pve/v1/pools/tank/scrub'),
        'the MAC covers method and path');
    ok(!assertion_ok($r->{call}{headers}{'X-Anas-Auth'}, 'GET', '/api/nodes/anas-pve/v1/pools/tank/scrub'),
        'the same MAC does not verify for another method');
    is($r->{call}{body}, '{}', 'the body is forwarded');

    $r = run(user => 'anas-np@pve');
    is(parse_assertion($r->{call}{headers}{'X-Anas-Auth'})->{privs}, 'Sys.Audit,Sys.Modify', 'propagate 0: both, end to end');
    $r = run(user => 'anas-none@pve');
    is(parse_assertion($r->{call}{headers}{'X-Anas-Auth'})->{privs}, '', 'no ACL: an empty privilege list, still signed');
}

# Row 7: the gateway has not written its key.
{
    local $AnasProxy::KEY_FILE = "$KEYDIR/absent.key";
    my $r = run(user => 'root@pam');
    is($r->{resp}->code, 502, 'no proxy key: 502');
    is($r->{body}{error}{message}, 'ANAS gateway not ready (no proxy key)', 'no proxy key: the sentence');
    is($r->{body}{error}{code}, 'UPSTREAM_UNREACHABLE', 'no proxy key: the code');
    like($r->{logs}[0], qr/\(root\@pam\): proxy key unreadable: /, 'no proxy key: logged with the user and errno');
    is($r->{calls}, 0, 'no proxy key: nothing forwarded unsigned');
}

# A privilege check that dies fails closed.
{
    no warnings 'redefine';
    local *FakeRPCEnv::check = sub { die "acl compile exploded\n" };
    my $r = run(user => 'root@pam');
    is($r->{resp}->code, 503, 'a dying privilege check: 503');
    like($r->{logs}[0], qr/privilege check failed: acl compile exploded$/, 'a dying privilege check: logged');
    is($r->{calls}, 0, 'a dying privilege check: nothing forwarded');
}

# Row 8: any other die is logged before the hook's own 500.
{
    no warnings 'redefine';
    local *AnasProxy::_authorize = sub { die "boom\n" };
    @LOGS = ();
    my $req = HTTP::Request->new('GET', URI->new('/anas/api/health'));
    eval { AnasProxy::handle(FakeServer->new, { request => $req, log => {} }, 'GET', $req->uri) };
    like($@, qr/^boom/, 'the die reaches the hook (which answers 500)');
    is($LOGS[0], 'anas-proxy: error on GET /api/health: boom', 'and is logged first');
}

done_testing();
