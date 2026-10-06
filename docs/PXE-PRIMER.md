# PXE boot — the primer behind the pxe.1 design pass

**Status:** background reading, written 2026-10-06 before any design pass. Nothing here is a
decision. The "Should we do this" section at the end is the recommendation the design pass
starts from; the operator rules on it.

## How a network boot actually happens

A PXE boot is four handoffs, each with its own protocol and its own failure modes.

1. **Firmware asks for a boot server.** The client's network ROM (BIOS PXE, or the UEFI
   network stack) sends an ordinary DHCP discover tagged with vendor class `PXEClient` and a
   client-architecture option. That option is how the server knows whether to hand out a BIOS
   loader, a 64-bit UEFI loader, or an ARM64 one. The wrong file here is the single most
   common PXE failure.
2. **Someone answers with a file name and a server.** The real DHCP server can do it
   (options 66 and 67), but on a home or lab network that server is a router nobody wants to
   reconfigure. The alternative is proxyDHCP, from the PXE spec itself: a second server on the
   same broadcast domain answers the same discover with no IP address, only the boot server
   and file name, and the client merges the two offers. dnsmasq does this in a few lines, with
   per-architecture file selection, and it includes a TFTP server. The constraint is that
   proxyDHCP must sit on the client's L2 segment. For VMs on a PVE bridge that is automatic,
   since the node is on the bridge. For other PVE nodes it means the same LAN or a VLAN
   interface on that bridge. Across routed subnets proxyDHCP does not reach, and the
   operator's own DHCP server has to carry the options. A design must state both paths.
3. **The firmware fetches a small loader over TFTP.** Firmware only speaks TFTP, which is
   slow and limited, so the loader's job is to switch to something better. The loader of
   choice is iPXE: one file per architecture, shipped in Debian's `ipxe` package; it speaks
   HTTP, detects its own architecture, and runs a script, which is how a boot menu exists.
   QEMU's own network ROM already is iPXE, and OVMF carries the iPXE EFI driver, so a PVE VM
   with `net0` first in its boot order starts in iPXE with no TFTP step at all. Newer firmware
   also offers UEFI HTTP Boot, where the DHCP answer is a URL and no TFTP is involved; OVMF
   supports it.
4. **The loader fetches the real payload over HTTP.** Kernel, initrd, and whatever the initrd
   needs to find its root. This is the part a server like ANAS would serve.

**Secure Boot** cuts across all of this. iPXE is not signed by Microsoft, so a client with
Secure Boot on refuses it. The signed chain is shim followed by GRUB, both from distro
packages, with a GRUB config served over TFTP or HTTP, and it can only boot signed kernels.
PVE's installer kernel and the Debian kernels are signed, so the chain works, but it loses
iPXE's scripting. PVE creates VM EFI disks with Secure Boot keys pre-enrolled by default, so
this is not an edge case for VMs. The honest first version is two chains (iPXE for Secure
Boot off, shim plus GRUB for Secure Boot on) or one chain and a documented switch.

## What a bootable image is, and how one gets built

An installer ISO is an ISO 9660 filesystem with an El Torito boot record pointing at two
things: a BIOS boot sector program, and a small FAT image that is a complete EFI system
partition. An isohybrid MBR and GPT are stamped on the front so the same file works on a USB
stick. xorriso builds all of that in one command, and the PVE installer ISO is built that way
around a kernel, an initrd, and two squashfs payloads, one for the base system and one for
the installer.

None of that structure matters for netboot. The network does not boot an ISO. It boots a
kernel and an initrd, and the initrd then has to find the rest of the system. An initrd is a
cpio archive, and the kernel accepts several cpio archives glued together, which is the trick
behind most netboot recipes:

- **Debian installer**: kernel plus a netboot initrd that fetches packages from a mirror. A
  preseed file served over HTTP automates it. Two files and a URL.
- **Proxmox VE installer**: the ISO carries its kernel and initrd, but the installer expects
  to find the ISO contents as a mounted disc. The documented netboot method is to append the
  whole ISO into the initrd as a second cpio archive, giving a roughly 1.3 GB initrd that must
  come over HTTP and needs about twice the ISO size in RAM. The automated install rides on
  this: the auto-install assistant stamps an answer file into the ISO, or configures the
  initrd to fetch the answer over HTTP at boot. In that mode the installer posts the
  machine's hardware facts (MAC addresses, serial, disks) and the server answers with a
  per-host answer file. That endpoint is the piece that turns "boot the PVE installer" into
  "provision this node".
- **Rescue and live systems** (SystemRescue, a Debian live image): kernel, initrd, and a
  squashfs fetched over HTTP, named on the kernel command line. Three files and a cmdline.
- **Windows**: iPXE's wimboot loads the boot manager and a WinPE image over HTTP, and the
  installer then wants its sources from an SMB share. Later, if ever.
- **Booting an ISO as a disk**: iPXE can present an ISO as a virtual drive and memdisk can
  load one into RAM, but most Linux kernels lose the virtual disc once they take over the
  hardware, and nothing in that family works under UEFI. Ruled out before it is tried.

So the "image creation" a server would do is mostly extraction and glue, not building: pull
the kernel and initrd out of an ISO the operator supplies or a mirror provides, run the PVE
repack when it is that installer, generate the iPXE menu script and per-entry kernel command
lines, and serve answer and preseed files. The real tools exist already: dnsmasq for
proxyDHCP and TFTP, the ipxe package for loaders, xorriso or bsdtar to open an ISO, cpio and
zstd to repack, and the auto-install assistant for answers.

## The decisions a design pass has to make

- **HTTP without a ticket.** Boot clients cannot authenticate, and the gateway sits behind
  PVE auth. The payloads need a plain HTTP listener, on its own port, read-only, serving only
  the catalog directory. Where that listener lives is a real architecture call.
- **A second dnsmasq on a PVE node.** PVE's SDN runs its own dnsmasq instances per zone. Ours
  has to be a separately named instance bound to one interface, never the system service.
- **Which interfaces to serve.** A node with several bridges and VLANs needs a chooser, and
  the answer differs for "my VMs" and "my other nodes".
- **Storage of the catalog.** Large files belong on a dataset the operator picks, not under
  `/etc` or `/opt`.
- **Secure Boot stance**, per the above.
- **Scope of a first cut.** PVE installer with answer files, Debian netboot, one rescue image,
  and a chain entry to netboot.xyz for everything else would cover the idea without building
  a distro catalog.

## Should we do this?

The recommendation going into the design pass: **not as an ANAS feature, not now.**

- **It is not storage.** ANAS is the storage layer PVE lacks. PXE is a network service with a
  file server behind it. The only storage-shaped part is "keep the images on a dataset",
  which any share already does.
- **Its blast radius is the whole LAN segment.** A proxyDHCP server answers every PXE client
  on the broadcast domain, including the office PC somebody left set to network boot. One
  wrong interface pick and a NAS add-on has hijacked boots across a network ANAS does not
  own. Judged as a live product with unknown users, that is the heaviest failure mode ANAS
  would carry, and it belongs to a feature with no demand signal yet.
- **The differentiated part is small, and it belongs elsewhere.** dnsmasq plus iPXE is a
  twenty-line config any PVE operator can keep by hand. The parts worth building are the
  per-host answer-file endpoint and the rescue catalog, and both are node provisioning and
  recovery: the parked DR project's shape, not a NAS menu.
- **Two things would change the answer.** A user asking for it in the issues, which would
  also say which half they want (VM boot menus or node provisioning). Or PVE SDN exposing
  boot options on its own DHCP, which would remove proxyDHCP entirely for the VM case and
  with it the blast radius; a VM-only cut would then be a small, safe feature.

Until one of those happens the idea stays in EPICS §4 as it is, and this primer is the
reading for whoever picks it up.

## Postscript: the Sun diskless model (operator, 2026-10-06)

The operator's actual interest was never installers (Ventoy covers those) but whether the
old Sun network boot could be replicated: a client with no disk that boots and runs entirely
from the file server. On Solaris that was RARP and bootparams for the handoff, TFTP for the
boot program, and a per-client root under `/export/root/<client>` plus a swap file, all on
NFS, with a shared `/usr`. That model maps onto today's tools and onto ANAS almost one to one:

- **Handoff:** proxyDHCP and iPXE as above, with one change that also removes the blast
  radius: answer only registered clients. dnsmasq's `dhcp-host` with a tag per MAC and
  `pxe-service` restricted to that tag means an unregistered machine on the segment is never
  answered. A client registry (MAC to root dataset) is the feature's core object anyway.
- **Boot program and kernel:** iPXE fetches the kernel and an initrd over HTTP; the initrd
  needs NFS-root or iSCSI support (Debian's initramfs-tools has both; `root=/dev/nfs
  nfsroot=<server>:/export/root/<client>,vers=4 ip=dhcp` is the whole command line).
- **Root filesystem:** a dataset per client, cloned from a golden template dataset in
  milliseconds and thin. NFS-exported through the existing shares. Snapshot and rollback per
  client is "reset the lab machine" for free, and the template is upgraded once and re-cloned.
  This is the part that is ANAS-shaped: the per-client root, the clone-from-template, and the
  rollback are dataset operations ANAS already has verbs for.
- **Swap:** a zvol per client over iSCSI (also existing), or no swap for RAM-rich clients.
- **The alternative root:** an iSCSI LUN per client, booted by iPXE's SAN boot. Windows
  boots this way natively; Linux needs an initrd with iSCSI support and the iBFT handoff.
  Fewer moving parts at boot, but no shared template and no clone-per-client cheapness.

Scope if ever built: a Clients page under Shares or Datasets (registry: MAC, architecture,
root dataset, template, kernel entry), a template dataset with a documented layout, the
dnsmasq instance answering registered MACs only, the HTTP listener for kernel and initrd.
Not an ask, limited use case; recorded so the shape is not re-derived.

**Within PVE's VM config, no DHCP involvement (operator question, 2026-10-06):**
1. *Direct kernel boot via `args`.* `qm set <vmid> --args "-kernel <path> -initrd <path> -append
   'root=/dev/nfs nfsroot=<node>:/<client-dataset>,vers=4 ip=dhcp'"`. No boot ROM, no PXE; the
   bridged NIC takes a normal lease and the kernel mounts root over NFS. SeaBIOS and OVMF both
   support it. Kernel and initrd must be on a dataset every node can read (migration). `args`
   is root-only and not in the GUI, but it is PVE's own supported field. The cleanest fit for
   the Sun model on VMs: storage side = template dataset + clone per VM + NFS export (all
   existing ANAS verbs); boot side = one line in the VM config.
2. *A `dhcp-boot` drop-in for a PVE SDN zone's dnsmasq.* Would hand iPXE only to VMs on that
   zone, no second DHCP server, no reach beyond the zone. UNVERIFIED whether the SDN dnsmasq
   instance reads a per-zone drop-in directory; check before counting on it.
3. *(hack)* A second NIC on QEMU user-mode networking, whose built-in DHCP/TFTP serves the
   loader; works from `args` alone but everything crosses a NAT.
Physical machines are not covered by any of these; proxyDHCP returns for them.
