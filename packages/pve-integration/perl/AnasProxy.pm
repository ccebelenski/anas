package AnasProxy;

# ANAS reverse-proxy handler (story 12.2 — see docs/PROXY-TRANSPORT-DESIGN.md)
# and the place PVE decides who and what for /anas (cr.27 —
# docs/WAVE2-DESIGN.md §2 A2, A2.1, A2.2, A5 and §5 rows 1-8).
#
# Invoked at request time by the additive hook spliced into
# PVE::APIServer::AnyEvent::handle_request. PVE authenticates only inside its
# /api2 branch, so /anas arrives here with nothing checked (F1). This module:
#
#   1. refuses to serve outside pveproxy — the hook also runs inside pvedaemon
#      on 127.0.0.1:85 (root, trusted_env), where PVE skips the CSRF check (F10);
#   2. forwards GET /anas/installed (the presence probe) without authenticating;
#   3. otherwise asks PVE, with PVE's own code: `auth_handler` — the method
#      pveproxy calls for /api2 (AnyEvent.pm:1622) — checks the ticket, that the
#      user exists and is enabled, the TFA state and, for every method but GET,
#      the CSRF token; then `$rpcenv->check` answers which of Sys.Audit and
#      Sys.Modify PVE grants the user on `/` (RPCEnvironment.pm:291-305);
#   4. hands the gateway a signed statement of that answer: the X-Anas-Auth
#      header, an HMAC over the user, the privileges, a timestamp, the method
#      and the forwarded path, keyed with the secret the gateway writes at
#      startup to /run/anas/proxy.key (root:www-data 0640). The gateway believes
#      only statements carrying that MAC (F11) and applies the one rule
#      (GET/HEAD → Sys.Audit, everything else → Sys.Modify).
#
# Every refusal is logged with its reason (journal unit pveproxy), so a check
# that refuses everyone can never do it silently.
#
# Non-blocking by construction: it uses AnyEvent::HTTP (NOT LWP) so a slow or
# large ANAS response never stalls the pveproxy event-loop worker — the same way
# pveproxy itself proxies to pvedaemon. http_request returns immediately and its
# callback fires later on pveproxy's own AnyEvent loop, at which point we call
# $self->response($reqstate, $resp).
#
# Guest philosophy (PRINCIPLES #12): this module is ANAS-owned and lives at
# /usr/share/anas/perl/AnasProxy.pm — PVE never ships or touches it. The hook
# `require`s it at request time inside an eval, so any fault here 500s /anas only
# and never affects :8006.

use strict;
use warnings;

use Digest::SHA ();
use HTTP::Response ();
use HTTP::Status ();
use JSON::PP ();

# Gateway loopback port. NODE-LOCAL, operator-configurable (issue #2): the
# installer writes ANAS_PORT into /etc/default/anas so the gateway service and
# this hook agree on one port per node. Absent/unset/malformed file => 3000, so
# behaviour is byte-identical to before when the file is not present.
our $DEFAULT_PORT = 3000;

# Env file the installer writes (KEY=VALUE). Overridable for tests.
our $ENV_FILE = '/etc/default/anas';

# The hand-off key (WAVE2-DESIGN A2.1). The gateway creates 32 random bytes at
# startup and writes them here, root:www-data 0640, atomically; a gateway
# restart rotates it. pveproxy workers run as www-data and read it through the
# group. Overridable for tests.
our $KEY_FILE = '/run/anas/proxy.key';

# The signed hand-off header. A client-supplied copy is always removed.
our $ASSERTION_HEADER = 'X-Anas-Auth';

# The two privileges ANAS asks PVE about, on `/` (EPICS §2 "Authorization
# follows PVE"; WAVE2-DESIGN A1). The gateway decides which one a request needs.
our @PRIVILEGES = ('Sys.Audit', 'Sys.Modify');

# PVE delays every unauthorized answer by 3 seconds (its own login-failure
# path in authenticate_and_handle_request); ANAS's 401s do the same.
# Overridable for tests.
our $UNAUTH_DELAY = 3;

# The effective uid, for the "served outside pveproxy" test. undef = $>.
# Overridable for tests (a CI runner may be root).
our $EUID;

# Log one line to the journal (unit pveproxy) through PVE's own syslog wrapper.
# Overridable for tests.
our $LOG = sub {
    my ($line) = @_;
    eval {
        require PVE::SafeSyslog;
        PVE::SafeSyslog::syslog('warning', '%s', $line);
    };
    warn "$line\n" if $@;
};

# PVE's own cookie/header value extractor — the one authenticate_and_handle_request
# uses for /api2 (AnyEvent.pm:1595-1611). Overridable for tests.
our $EXTRACT_AUTH = sub {
    require PVE::APIServer::Formatter;
    return PVE::APIServer::Formatter::extract_auth_value(@_);
};

# Pure: extract ANAS_PORT from env-file *contents* (a string), returning a valid
# port (1-65535) or undef. Shell semantics — last assignment wins. Tolerates an
# optional 'export ', surrounding quotes, an inline '#' comment and whitespace.
# Unit-testable without touching the filesystem.
sub _parse_port {
    my ($contents) = @_;
    return undef if !defined $contents;
    my $port;
    for my $line (split /\n/, $contents) {
        next if !defined $line;
        next if $line =~ /^\s*#/;                 # comment line
        next if $line !~ /^\s*(?:export\s+)?ANAS_PORT\s*=\s*(.*)$/;
        my $val = $1;
        $val =~ s/\s+#.*$//;                       # strip inline comment
        $val =~ s/^(['"])(.*)\1$/$2/;              # strip matching quotes
        $val =~ s/^\s+//; $val =~ s/\s+$//;        # trim
        next if $val !~ /^\d+$/;
        next if $val < 1 || $val > 65535;
        $port = $val + 0;                          # last valid assignment wins
    }
    return $port;
}

# Read $ENV_FILE (or an explicit path, for tests) and build the loopback gateway
# origin. Any failure to obtain a valid port falls back to $DEFAULT_PORT, so a
# missing/unreadable/malformed file yields the historical http://127.0.0.1:3000.
sub _resolve_gateway {
    my ($path) = @_;
    $path = $ENV_FILE if !defined $path;
    my $port = $DEFAULT_PORT;
    if (defined $path && open(my $fh, '<', $path)) {
        local $/;
        my $contents = <$fh>;
        close $fh;
        my $p = _parse_port($contents);
        $port = $p if defined $p;
    }
    return "http://127.0.0.1:$port";
}

# Loopback gateway origin (plain HTTP). Resolved once at load time from the env
# file; still overridable directly for tests (see t/AnasProxy.t).
our $GATEWAY = _resolve_gateway();

# Upstream request timeout (seconds). ANAS mutations return 202 immediately and
# reads are quick, so a short ceiling is safe and stops a worker from lingering
# on a stuck gateway.
our $TIMEOUT = 30;

# Hop-by-hop headers (RFC 7230 §6.1) — stripped in BOTH directions. Keys are
# lowercase for case-insensitive comparison.
my %HOP_BY_HOP = map { $_ => 1 } qw(
    connection keep-alive proxy-authenticate proxy-authorization
    te trailer transfer-encoding upgrade
);

# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without AnyEvent or PVE).
# ---------------------------------------------------------------------------

# The forwarded request target: the /anas prefix removed, the query kept —
# exactly the string AnyEvent::HTTP sends as the request-target and the gateway
# reads as request.url. The hook only calls us for ^/anas(?:/|$), so this
# removes exactly the prefix segment: /anas -> '/', /anas/api/... -> /api/...
sub _forward_target {
    my ($uri) = @_;
    my $path = defined($uri) ? $uri->path : '/';
    $path = '/' if !defined($path);
    $path =~ s{^/anas(?=/|$)}{};
    $path = '/' if $path eq '';
    my $query = defined($uri) ? $uri->query : undef;
    $path .= '?' . $query if defined($query) && $query ne '';
    return $path;
}

# The full loopback URL for a request.
sub _target_url {
    my ($uri) = @_;
    return $GATEWAY . _forward_target($uri);
}

# Host:port of the loopback gateway, for the forced Host header.
sub _host_header {
    my $h = $GATEWAY;
    $h =~ s{^https?://}{};
    $h =~ s{/.*$}{};
    return $h;
}

# Build the forward request headers from the incoming HTTP::Headers. Drop
# hop-by-hop, Client-* (LWP artifacts), Host, Content-Length (framing — the body
# length is set from the body itself), Accept-Encoding (so the gateway answers
# uncompressed and PVE's response() owns compression) and any client-supplied
# X-Anas-Auth (only this module may state who the user is — F11). Cookie,
# CSRFPreventionToken and Content-Type pass through untouched (the gateway
# forwards the first two on a cross-node hop, where the peer's pveproxy checks
# them again). Returns a hashref.
sub _request_headers {
    my ($headers) = @_;
    my %out;
    my $assertion = lc $ASSERTION_HEADER;
    if ($headers) {
        $headers->scan(sub {
            my ($k, $v) = @_;
            my $lk = lc $k;
            return if $HOP_BY_HOP{$lk};
            return if $lk eq 'host';
            return if $lk eq 'content-length';
            return if $lk eq 'accept-encoding';
            return if $lk eq $assertion;
            return if $lk =~ /^client-/;
            $out{$k} = $v;
        });
    }
    $out{Host} = _host_header();
    return \%out;
}

# Filter an upstream response's headers. AnyEvent::HTTP delivers them as a
# lowercase-keyed hashref with capitalised pseudo-headers (Status, Reason,
# HTTPVersion, URL, ...). Drop those pseudo-headers, hop-by-hop, Content-Length
# (response() recomputes it from the content) and Client-*. Returns an arrayref
# of [name, value] pairs.
sub _response_headers {
    my ($hdr) = @_;
    my @out;
    for my $k (sort keys %{ $hdr || {} }) {
        next if $k =~ /^[A-Z]/;          # AnyEvent pseudo-headers
        next if $HOP_BY_HOP{$k};
        next if $k eq 'content-length';
        next if $k =~ /^client-/;
        push @out, [ $k, $hdr->{$k} ];
    }
    return \@out;
}

# A2.2: the reason this server must not serve ANAS, or undef. pvedaemon is
# root and trusted_env; HTTPServer::auth_handler skips the CSRF check when
# euid == 0 (HTTPServer.pm:126-130), so ANAS is not served there at all.
sub _outside_pveproxy {
    my ($server, $euid) = @_;
    return 'served outside pveproxy (trusted_env)' if $server && $server->{trusted_env};
    return 'served outside pveproxy (euid 0)' if defined($euid) && $euid == 0;
    return undef;
}

# The one request that is forwarded without authenticating: the presence
# probe the panels hit before login (the gateway exempts the same one).
sub _exempt {
    my ($method, $target) = @_;
    my ($path) = split /\?/, $target, 2;
    return ($method eq 'GET' && defined($path) && $path eq '/installed') ? 1 : 0;
}

# The credentials, found exactly where authenticate_and_handle_request finds
# them for /api2 (AnyEvent.pm:1591-1611): the ticket from the cookie, else from
# the Authorization header; an API token only when there is no ticket.
sub _credentials {
    my ($headers, $cookie_name, $apitoken_name, $extract) = @_;
    my $cookie = $headers ? $headers->header('Cookie') : undef;
    my $auth_header = $headers ? $headers->header('Authorization') : undef;
    my $ticket = $extract->($cookie, $cookie_name);
    $ticket = $extract->($auth_header, $cookie_name) if !$ticket;
    my $api_token;
    $api_token = $extract->($auth_header, $apitoken_name) if !$ticket;
    return {
        ticket    => $ticket,
        api_token => $api_token,
        csrf      => $headers ? scalar($headers->header('CSRFPreventionToken')) : undef,
        forwarded => ($headers && defined($headers->header('X-Anas-Forwarded'))) ? 1 : 0,
    };
}

# Map what auth_handler died with to a refusal. Its dies, quoted from PVE
# (HTTPServer.pm:54-141 and Ticket.pm:29-50, docs/probes/wave2/01 and 03):
#   "RPCEnvironment init request failed: <err>\n"  (raise, no code)
#   "No ticket\n"                                  (no ticket; or a TFA half-ticket)
#   "Authentication failed!\n"                     (bad/expired ticket; a user that
#                                                   is unknown, disabled or expired)
#   "Permission denied - invalid csrf token\n"     (raise, code 401)
# Anything else fails closed as a 401 naming PVE's message.
sub _auth_refusal {
    my ($err, $cred) = @_;
    my $msg = (ref($err) && ref($err) ne 'SCALAR' && eval { exists $err->{msg} }) ? $err->{msg} : "$err";
    $msg = '' if !defined $msg;
    chomp $msg;
    my $code = (ref($err) && eval { $err->{code} }) ? $err->{code} : undef;

    if ($msg =~ /^RPCEnvironment init request failed: (.*)$/s) {
        my $why = $1;
        $why =~ s/\s+$//;
        return { status => 503, code => 'UNAVAILABLE',
            message => "PVE access control unavailable: $why", reason => $msg };
    }
    if ($msg =~ /invalid csrf token/) {
        if ($cred && $cred->{forwarded} && !defined($cred->{csrf})) {
            return { status => 401, code => 'UNAUTHORIZED', delay => 1,
                message => "$msg: the request was forwarded without a CSRF token: the forwarding node's ANAS is older than this one",
                reason => 'invalid csrf token (forwarded without one)' };
        }
        return { status => 401, code => 'UNAUTHORIZED', delay => 1,
            message => $msg, reason => 'invalid csrf token' };
    }
    if ($msg eq 'No ticket') {
        return { status => 401, code => 'UNAUTHORIZED', delay => 1,
            message => 'Access ANAS through the Proxmox UI', reason => 'no ticket' };
    }
    if ($msg eq 'Authentication failed!') {
        return { status => 401, code => 'UNAUTHORIZED', delay => 1,
            message => $msg, reason => 'authentication failed' };
    }
    my $status = (defined($code) && $code =~ /^\d{3}$/ && $code >= 400) ? $code + 0 : 401;
    return { status => $status, code => ($status == 403 ? 'FORBIDDEN' : 'UNAUTHORIZED'),
        delay => ($status == 401 ? 1 : 0),
        message => "Authentication failed: $msg", reason => "auth_handler: $msg" };
}

# Which of @PRIVILEGES PVE grants $userid on `/`. $check has the signature and
# semantics of PVE::RPCEnvironment::check($self, $user, $path, $privs, $noerr)
# with $noerr set: true when granted, undef when not (a privilege is granted
# when its key is DEFINED in the compiled map, whatever its propagate value —
# RPCEnvironment.pm:121-131, 291-305).
sub _granted {
    my ($check, $userid) = @_;
    return [ grep { $check->($userid, '/', [$_], 1) } @PRIVILEGES ];
}

# Percent-encode a header field so it can carry any user id: PVE's user name
# part allows everything but whitespace, ':' and '/', so ';', '=' and ','
# would otherwise split the header. Applied to the bytes.
sub _escape_field {
    my ($s) = @_;
    $s = '' if !defined $s;
    utf8::encode($s) if utf8::is_utf8($s);
    $s =~ s/([^A-Za-z0-9_.~\@!\-])/sprintf('%%%02X', ord($1))/ge;
    return $s;
}

# The X-Anas-Auth value (WAVE2-DESIGN A2.1):
#   v1;user=<userid>;privs=<Sys.Audit,Sys.Modify|Sys.Audit|>;ts=<epoch>;mac=<hex>
# MAC = HMAC-SHA256(key, "v1\n<user>\n<privs>\n<ts>\n<METHOD>\n<path?query>"),
# over the fields exactly as sent (the user field percent-encoded) and the
# request-target as forwarded (no /anas prefix).
sub _assertion {
    my ($key, $userid, $privs, $ts, $method, $target) = @_;
    my $user = _escape_field($userid);
    my $p = join(',', @$privs);
    my $mac = Digest::SHA::hmac_sha256_hex(
        join("\n", 'v1', $user, $p, $ts, $method, $target), $key);
    return "v1;user=$user;privs=$p;ts=$ts;mac=$mac";
}

# Read the hand-off key, cached by device/inode/mtime/size (a gateway restart
# renames a new file into place, so the inode changes). Returns ($key, undef)
# or (undef, $reason). Never caches a failure.
my %KEY_CACHE;
sub _read_key {
    my ($path) = @_;
    $path = $KEY_FILE if !defined $path;
    my @st = stat($path);
    return (undef, "proxy key unreadable: $path: $!") if !@st;
    my $id = join(':', $path, @st[0, 1, 9, 7]);
    return ($KEY_CACHE{key}, undef) if defined($KEY_CACHE{id}) && $KEY_CACHE{id} eq $id;
    my $fh;
    return (undef, "proxy key unreadable: $path: $!") if !open($fh, '<:raw', $path);
    my $key = do { local $/; <$fh> };
    close $fh;
    return (undef, "proxy key unreadable: $path: shorter than 32 bytes")
        if !defined($key) || length($key) < 32;
    %KEY_CACHE = (id => $id, key => $key);
    return ($key, undef);
}

# The ANAS error envelope as an HTTP::Response.
sub _envelope {
    my ($status, $code, $message) = @_;
    my $resp = HTTP::Response->new($status, HTTP::Status::status_message($status) || 'Error');
    $resp->header('Content-Type' => 'application/json');
    $resp->content(JSON::PP->new->canonical->ascii->encode(
        { error => { code => $code, message => $message } }));
    return $resp;
}

# ---------------------------------------------------------------------------
# The PVE binding.
# ---------------------------------------------------------------------------

# Ask PVE who the user is and what it grants on `/`. Returns
# { userid, privs } or { refuse => {status, code, message, reason}, userid? }.
sub _authorize {
    my ($self, $reqstate, $method, $target, $headers) = @_;

    my $cred = _credentials($headers,
        $self->{cookie_name} || 'PVEAuthCookie',
        $self->{apitoken_name} || 'PVEAPIToken',
        $EXTRACT_AUTH);

    # A5: API tokens stay closed in 0.4.4.
    return { refuse => { status => 401, code => 'UNAUTHORIZED', delay => 1,
        message => 'PVE API tokens are not accepted by ANAS', reason => 'API token presented' } }
        if $cred->{api_token};
    return { refuse => { status => 401, code => 'UNAUTHORIZED', delay => 1,
        message => 'Access ANAS through the Proxmox UI', reason => 'no ticket' } }
        if !$cred->{ticket};

    my ($rel_uri) = split /\?/, "/anas$target", 2;
    my $auth = eval {
        $self->auth_handler($method, $rel_uri, $cred->{ticket}, $cred->{csrf}, undef,
            $reqstate->{peer_host});
    };
    if (my $err = $@) {
        # auth_handler sets the user before it checks the CSRF token, so a
        # token refusal still names whose request it was (log and access log).
        my $known = eval { $self->{rpcenv} ? $self->{rpcenv}->get_user(1) : undef };
        return { refuse => _auth_refusal($err, $cred),
            (defined($known) && $known ne '' ? (userid => $known) : ()) };
    }
    my $userid = (ref($auth) eq 'HASH') ? $auth->{userid} : undef;
    if (!defined($userid) || $userid eq '') {
        return { refuse => { status => 500, code => 'INTERNAL_ERROR',
            message => 'ANAS proxy error: PVE authenticated no user',
            reason => 'auth_handler returned no user id' } };
    }

    my $rpcenv = $self->{rpcenv};
    my $privs = eval {
        die "no RPC environment\n" if !$rpcenv;
        _granted(sub { $rpcenv->check(@_) }, $userid);
    };
    if (my $err = $@) {
        chomp(my $e = "$err");
        return { userid => $userid, refuse => { status => 503, code => 'UNAVAILABLE',
            message => "PVE privilege check failed: $e", reason => "privilege check failed: $e" } };
    }
    return { userid => $userid, privs => $privs };
}

# ---------------------------------------------------------------------------
# Request handler.
# ---------------------------------------------------------------------------

# The hook's own eval answers a die with a bare 500 and drops the error
# (WAVE2-DESIGN §5 row 8); catch it here first so the reason reaches the log.
sub handle {
    my ($self, $reqstate, $method, $uri) = @_;
    eval { _handle($self, $reqstate, $method, $uri); };
    if (my $err = $@) {
        chomp(my $e = "$err");
        my $path = eval { _forward_target($uri) };
        $path = '?' if !defined $path;
        ($path) = split /\?/, $path, 2;
        $LOG->("anas-proxy: error on $method $path: $e");
        die $err;    # the hook's eval answers 500 'ANAS proxy error'
    }
    return;
}

sub _handle {
    my ($self, $reqstate, $method, $uri) = @_;

    my $request    = $reqstate->{request};
    my $in_headers = $request ? $request->headers : undef;
    my $target     = _forward_target($uri);
    my $euid       = defined($EUID) ? $EUID : $>;

    if (my $why = _outside_pveproxy($self, $euid)) {
        return _refuse($self, $reqstate, $method, $target, { status => 404, code => 'NOT_FOUND',
            message => 'ANAS is served through pveproxy on :8006 only', reason => $why });
    }

    return _forward($self, $reqstate, $method, $target, $in_headers, undef)
        if _exempt($method, $target);

    my $decision = _authorize($self, $reqstate, $method, $target, $in_headers);
    # The access log names the user on /anas lines as it does on /api2 (F1).
    $reqstate->{log}->{userid} = $decision->{userid} if defined $decision->{userid};
    return _refuse($self, $reqstate, $method, $target, $decision->{refuse})
        if $decision->{refuse};

    my ($key, $why) = _read_key();
    return _refuse($self, $reqstate, $method, $target, { status => 502,
        code => 'UPSTREAM_UNREACHABLE', message => 'ANAS gateway not ready (no proxy key)',
        reason => $why }) if !defined $key;

    my $assertion = _assertion($key, $decision->{userid}, $decision->{privs}, time(),
        $method, $target);
    return _forward($self, $reqstate, $method, $target, $in_headers, $assertion);
}

# Log the refusal (always), then answer with the ANAS envelope — a 401 after
# PVE's 3 s delay.
sub _refuse {
    my ($self, $reqstate, $method, $target, $r) = @_;
    my ($path) = split /\?/, $target, 2;
    my $peer = defined($reqstate->{peer_host}) ? $reqstate->{peer_host} : '-';
    my $who = defined($reqstate->{log}->{userid}) ? " ($reqstate->{log}->{userid})" : '';
    $LOG->("anas-proxy: refused $method $path from $peer$who: $r->{reason}");

    my $resp = _envelope($r->{status}, $r->{code}, $r->{message});
    if ($r->{delay} && $UNAUTH_DELAY > 0) {
        require AnyEvent;
        $reqstate->{anas_proxy_delay} = AnyEvent->timer(after => $UNAUTH_DELAY, cb => sub {
            delete $reqstate->{anas_proxy_delay};
            eval { $self->response($reqstate, $resp); };
        });
        return;
    }
    eval { $self->response($reqstate, $resp); };
    return;
}

sub _forward {
    my ($self, $reqstate, $method, $target, $in_headers, $assertion) = @_;

    # Loaded lazily at request time: AnasProxy.pm stays perl -c clean on hosts
    # without AnyEvent::HTTP, and the hook already require's US inside an eval,
    # so a load failure 500s /anas only.
    require AnyEvent::HTTP;

    my $request     = $reqstate->{request};
    my $body        = $request ? $request->content : undef;
    my $url         = $GATEWAY . $target;
    my $fwd_headers = _request_headers($in_headers);
    $fwd_headers->{$ASSERTION_HEADER} = $assertion if defined $assertion;
    my @body_arg    = (defined($body) && length($body)) ? (body => $body) : ();

    # http_request returns a guard that MUST stay alive until the callback fires,
    # or the in-flight request is cancelled. Park it on $reqstate, which lives
    # for the duration of the request; the callback clears it.
    $reqstate->{anas_proxy_guard} = AnyEvent::HTTP::http_request(
        $method => $url,
        headers    => $fwd_headers,
        @body_arg,
        timeout    => $TIMEOUT,
        recurse    => 0,      # never follow redirects on ANAS's behalf
        keepalive  => 0,
        persistent => 0,
        sub {
            my ($data, $hdr) = @_;
            delete $reqstate->{anas_proxy_guard};

            my $status = $hdr->{Status};
            # AnyEvent::HTTP reports transport errors (connection refused, TLS,
            # timeout, ...) as pseudo-status 59x. Gateway unreachable -> 502.
            if (!defined($status) || $status =~ /^59\d$/) {
                return _respond_502($self, $reqstate, $method, $target, $status, $hdr->{Reason});
            }

            my $reason = $hdr->{Reason};
            $reason = HTTP::Status::status_message($status)
                if !defined($reason) || $reason eq '';
            $reason = 'OK' if !defined($reason) || $reason eq '';

            my $resp = HTTP::Response->new($status + 0, $reason);
            for my $pair (@{ _response_headers($hdr) }) {
                $resp->push_header($pair->[0], $pair->[1]);
            }
            $resp->content(defined($data) ? $data : '');

            # Hand back via the reqstate callback pattern. response() owns
            # compression (we dropped Accept-Encoding on the way in).
            eval { $self->response($reqstate, $resp); };
            # If response() throws the client connection is already gone; there
            # is nothing further to do.
        },
    );
    return;
}

# Synthetic 502 when the loopback gateway cannot be reached. Logged like every
# other answer this module gives (cr.27 review: it was the one silent path), with
# AnyEvent::HTTP's transport pseudo-status and reason so the journal says WHY.
sub _respond_502 {
    my ($self, $reqstate, $method, $target, $status, $reason) = @_;
    my ($path) = split /\?/, (defined($target) ? $target : '-'), 2;
    my $peer = (ref($reqstate) eq 'HASH' && defined($reqstate->{peer_host})) ? $reqstate->{peer_host} : '-';
    my $why  = (defined($status) ? $status : 'no status') . (defined($reason) && $reason ne '' ? " $reason" : '');
    $LOG->("anas-proxy: 502 for " . (defined($method) ? $method : '-') . " $path from $peer: gateway not reachable on the loopback interface ($why)");
    my $resp = HTTP::Response->new(502, 'Bad Gateway');
    $resp->header('Content-Type' => 'application/json');
    $resp->content(
        '{"error":{"code":"UPSTREAM_UNREACHABLE",'
        . '"message":"ANAS gateway not reachable on the loopback interface"}}'
    );
    eval { $self->response($reqstate, $resp); };
    return;
}

1;
