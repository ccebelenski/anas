#!/usr/bin/perl
#
# Unit tests for the pure helpers of AnasProxy.pm — prefix stripping and
# bidirectional header filtering. These do not touch AnyEvent (which handle()
# loads lazily), so the suite runs anywhere perl + HTTP::Headers exist.
#
#   perl packages/pve-integration/perl/t/AnasProxy.t

use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/..";
use Test::More;
use HTTP::Headers ();
use URI ();
use File::Temp ();

require_ok('AnasProxy.pm');

# --- _parse_port: pull ANAS_PORT out of env-file contents (issue #2) --------
{
    is(AnasProxy::_parse_port("ANAS_PORT=3001\n"), 3001,
        'plain KEY=VALUE');
    is(AnasProxy::_parse_port("ANAS_PORT=3001"), 3001,
        'no trailing newline');
    is(AnasProxy::_parse_port("export ANAS_PORT=3002\n"), 3002,
        "'export ' prefix tolerated");
    is(AnasProxy::_parse_port(qq{ANAS_PORT="3003"\n}), 3003,
        'double-quoted value');
    is(AnasProxy::_parse_port("ANAS_PORT='3004'\n"), 3004,
        'single-quoted value');
    is(AnasProxy::_parse_port("ANAS_PORT=3005  # the port\n"), 3005,
        'inline comment stripped');
    is(AnasProxy::_parse_port("  ANAS_PORT = 3006 \n"), 3006,
        'surrounding whitespace tolerated');
    is(AnasProxy::_parse_port("ANAS_PORT=3000\nANAS_PORT=3007\n"), 3007,
        'last valid assignment wins (shell semantics)');
    is(AnasProxy::_parse_port("# ANAS_PORT=9999\nANAS_PORT=3008\n"), 3008,
        'commented-out line ignored');

    is(AnasProxy::_parse_port("OTHER=1\n"), undef,
        'no ANAS_PORT -> undef');
    is(AnasProxy::_parse_port(""), undef,
        'empty contents -> undef');
    is(AnasProxy::_parse_port(undef), undef,
        'undef contents -> undef');
    is(AnasProxy::_parse_port("ANAS_PORT=abc\n"), undef,
        'non-numeric value -> undef');
    is(AnasProxy::_parse_port("ANAS_PORT=0\n"), undef,
        'port 0 out of range -> undef');
    is(AnasProxy::_parse_port("ANAS_PORT=70000\n"), undef,
        'port > 65535 out of range -> undef');
    is(AnasProxy::_parse_port("ANAS_PORT=\n"), undef,
        'empty value -> undef');
}

# --- _resolve_gateway: env file -> loopback origin, 3000 fallback -----------
{
    my $dir = File::Temp->newdir;
    my $good = "$dir/good";
    open(my $g, '>', $good) or die $!;
    print $g "ANAS_PORT=3210\n";
    close $g;
    is(AnasProxy::_resolve_gateway($good), 'http://127.0.0.1:3210',
        'reads the configured port from the env file');

    my $bad = "$dir/bad";
    open(my $b, '>', $bad) or die $!;
    print $b "ANAS_PORT=nonsense\n";
    close $b;
    is(AnasProxy::_resolve_gateway($bad), 'http://127.0.0.1:3000',
        'malformed value falls back to 3000');

    my $missingkey = "$dir/missingkey";
    open(my $m, '>', $missingkey) or die $!;
    print $m "SOMETHING_ELSE=1\n";
    close $m;
    is(AnasProxy::_resolve_gateway($missingkey), 'http://127.0.0.1:3000',
        'missing ANAS_PORT falls back to 3000');

    is(AnasProxy::_resolve_gateway("$dir/does-not-exist"), 'http://127.0.0.1:3000',
        'absent file falls back to 3000 (byte-identical to pre-issue-#2)');
}

# --- _target_url: /anas prefix stripping + query preservation --------------
{
    local $AnasProxy::GATEWAY = 'http://127.0.0.1:3000';

    is(AnasProxy::_target_url(URI->new('/anas/api/nodes/pve1/v1/pools')),
        'http://127.0.0.1:3000/api/nodes/pve1/v1/pools',
        'strips /anas prefix from a nested path');

    is(AnasProxy::_target_url(URI->new('/anas')),
        'http://127.0.0.1:3000/',
        'bare /anas maps to /');

    is(AnasProxy::_target_url(URI->new('/anas/')),
        'http://127.0.0.1:3000/',
        'trailing-slash /anas/ maps to /');

    is(AnasProxy::_target_url(URI->new('/anas/api/health?x=1&y=2')),
        'http://127.0.0.1:3000/api/health?x=1&y=2',
        'query string is preserved');

    is(AnasProxy::_target_url(URI->new('/anas/installed')),
        'http://127.0.0.1:3000/installed',
        'unauthenticated probe path passes through');
}

# --- _request_headers: forward filtering -----------------------------------
{
    local $AnasProxy::GATEWAY = 'http://127.0.0.1:3000';
    my $h = HTTP::Headers->new;
    $h->header('Cookie'              => 'PVEAuthCookie=abc');
    $h->header('CSRFPreventionToken' => 'tok');
    $h->header('Content-Type'        => 'application/json');
    $h->header('Content-Length'      => '123');
    $h->header('Accept-Encoding'     => 'gzip');
    $h->header('Connection'          => 'keep-alive');
    $h->header('Transfer-Encoding'   => 'chunked');
    $h->header('Client-Peer'         => '1.2.3.4');
    $h->header('Host'                 => 'node:8006');

    my $out = AnasProxy::_request_headers($h);

    is($out->{Cookie}, 'PVEAuthCookie=abc', 'Cookie forwarded intact');
    is($out->{CSRFPreventionToken}, 'tok', 'CSRF token forwarded intact');
    is($out->{'Content-Type'}, 'application/json', 'Content-Type forwarded intact');
    is($out->{Host}, '127.0.0.1:3000', 'Host forced to the loopback gateway');
    ok(!exists $out->{'Content-Length'}, 'Content-Length stripped (framing)');
    ok(!exists $out->{'Accept-Encoding'}, 'Accept-Encoding dropped (PVE owns compression)');
    ok(!exists $out->{Connection}, 'Connection stripped (hop-by-hop)');
    ok(!exists $out->{'Transfer-Encoding'}, 'Transfer-Encoding stripped (framing)');
    ok(!exists $out->{'Client-Peer'}, 'Client-* stripped');
}

# --- _response_headers: reverse filtering ----------------------------------
{
    # AnyEvent::HTTP shape: lowercase real headers + capitalised pseudo-headers.
    my $hdr = {
        'Status'           => '200',
        'Reason'           => 'OK',
        'HTTPVersion'      => '1.1',
        'URL'              => 'http://127.0.0.1:3000/api/health',
        'content-type'     => 'application/json',
        'content-length'   => '42',
        'x-anas-version'   => '0.9.0',
        'connection'       => 'close',
        'transfer-encoding'=> 'chunked',
        'client-date'      => 'now',
    };
    my %got = map { $_->[0] => $_->[1] } @{ AnasProxy::_response_headers($hdr) };

    is($got{'content-type'}, 'application/json', 'content-type passed back');
    is($got{'x-anas-version'}, '0.9.0', 'x-anas-version passed back');
    ok(!exists $got{Status}, 'Status pseudo-header dropped');
    ok(!exists $got{Reason}, 'Reason pseudo-header dropped');
    ok(!exists $got{HTTPVersion}, 'HTTPVersion pseudo-header dropped');
    ok(!exists $got{URL}, 'URL pseudo-header dropped');
    ok(!exists $got{'content-length'}, 'content-length dropped (response() recomputes)');
    ok(!exists $got{'connection'}, 'connection stripped (hop-by-hop)');
    ok(!exists $got{'transfer-encoding'}, 'transfer-encoding stripped (framing)');
    ok(!exists $got{'client-date'}, 'client-* stripped');
}

# --- _respond_502: synthetic upstream-unreachable body ---------------------
{
    my $captured;
    my $fake_self = bless {}, 'AnasProxyTest::FakeServer';
    { no strict 'refs';
      *{'AnasProxyTest::FakeServer::response'} = sub {
          my ($s, $rs, $resp) = @_; $captured = $resp; };
    }
    AnasProxy::_respond_502($fake_self, {});
    ok($captured, 'response() was called');
    is($captured->code, 502, '502 status');
    like($captured->content, qr/UPSTREAM_UNREACHABLE/, 'carries the UPSTREAM_UNREACHABLE code');
    is($captured->header('Content-Type'), 'application/json', 'JSON content type');
}

done_testing();
