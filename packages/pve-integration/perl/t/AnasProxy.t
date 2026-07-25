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

require_ok('AnasProxy.pm');

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
