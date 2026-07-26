#!/bin/sh -eu

# directly exit successfully when zfs module is not loaded
if ! [ -d /sys/module/zfs ]; then
	exit 0
fi

# [auto] / enable / disable
PROPERTY_NAME="org.debian:periodic-scrub"

get_property () {
	# Detect the ${PROPERTY_NAME} property on a given pool.
	# We are abusing user-defined properties on the root dataset,
	# since they're not available on pools https://github.com/openzfs/zfs/pull/11680
	# TODO: use zpool user-defined property when such feature is available.
	pool="$1"
	zfs get -H -o value "${PROPERTY_NAME}" "${pool}" 2>/dev/null || return 1
}

scrub_if_not_scrub_in_progress () {
	pool="$1"
	if ! zpool status "${pool}" | grep -q "scrub in progress"; then
		# Ignore errors and continue with scrubbing other pools.
		zpool scrub "${pool}" || true
	fi
}

# Scrub all healthy pools that are not already scrubbing as per their configs.
zpool list -H -o health,name 2>&1 | \
	awk -F'\t' '$1 == "ONLINE" {print $2}' | \
while read pool
do
	# read user-defined config
	ret=$(get_property "${pool}")
	if [ $? -ne 0 ] || [ "disable" = "${ret}" ]; then
		:
	elif [ "-" = "${ret}" ] || [ "auto" = "${ret}" ] || [ "enable" = "${ret}" ]; then
		scrub_if_not_scrub_in_progress "${pool}"
	else
		cat > /dev/stderr <<EOF
$0: [WARNING] illegal value "${ret}" for property "${PROPERTY_NAME}" of ZFS dataset "${pool}".
$0: Acceptable choices for this property are: auto, enable, disable. The default is auto.
EOF
	fi
done
