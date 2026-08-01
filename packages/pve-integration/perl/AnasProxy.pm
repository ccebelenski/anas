package AnasProxy;

# ANAS reverse-proxy handler (story 12.2 — see docs/PROXY-TRANSPORT-DESIGN.md).
#
# Invoked at request time by the additive hook spliced into
# PVE::APIServer::AnyEvent::handle_request. It forwards /anas/* requests that
# arrive on pveproxy :8006 to the ANAS gateway bound on the loopback interface
# (127.0.0.1:3000, plain HTTP — pveproxy terminates TLS), then hands the
# gateway's response back to pveproxy.
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

use HTTP::Response ();
use HTTP::Status ();

# Gateway loopback port. NODE-LOCAL, operator-configurable (issue #2): the
# installer writes ANAS_PORT into /etc/default/anas so the gateway service and
# this hook agree on one port per node. Absent/unset/malformed file => 3000, so
# behaviour is byte-identical to before when the file is not present.
our $DEFAULT_PORT = 3000;

# Env file the installer writes (KEY=VALUE). Overridable for tests.
our $ENV_FILE = '/etc/default/anas';

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
# Pure helpers (unit-testable without AnyEvent).
# ---------------------------------------------------------------------------

# Strip the /anas prefix and rebuild the loopback target URL (path + query).
# The hook only calls us for ^/anas(?:/|$), so this removes exactly the prefix
# segment: /anas -> '/', /anas/api/... -> /api/...
sub _target_url {
    my ($uri) = @_;
    my $path = defined($uri) ? $uri->path : '/';
    $path = '/' if !defined($path);
    $path =~ s{^/anas(?=/|$)}{};
    $path = '/' if $path eq '';
    my $query = defined($uri) ? $uri->query : undef;
    my $url = $GATEWAY . $path;
    $url .= '?' . $query if defined($query) && $query ne '';
    return $url;
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
# length is set from the body itself) and Accept-Encoding (so the gateway
# answers uncompressed and PVE's response() owns compression). Cookie,
# CSRFPreventionToken and Content-Type pass through untouched. Returns a hashref.
sub _request_headers {
    my ($headers) = @_;
    my %out;
    if ($headers) {
        $headers->scan(sub {
            my ($k, $v) = @_;
            my $lk = lc $k;
            return if $HOP_BY_HOP{$lk};
            return if $lk eq 'host';
            return if $lk eq 'content-length';
            return if $lk eq 'accept-encoding';
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

# ---------------------------------------------------------------------------
# Request handler.
# ---------------------------------------------------------------------------

sub handle {
    my ($self, $reqstate, $method, $uri) = @_;

    # Loaded lazily at request time: AnasProxy.pm stays perl -c clean on hosts
    # without AnyEvent::HTTP, and the hook already require's US inside an eval,
    # so a load failure 500s /anas only.
    require AnyEvent::HTTP;

    my $request    = $reqstate->{request};
    my $in_headers = $request ? $request->headers : undef;
    my $body       = $request ? $request->content : undef;

    my $url         = _target_url($uri);
    my $fwd_headers = _request_headers($in_headers);
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
                return _respond_502($self, $reqstate);
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

# Synthetic 502 when the loopback gateway cannot be reached.
sub _respond_502 {
    my ($self, $reqstate) = @_;
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
