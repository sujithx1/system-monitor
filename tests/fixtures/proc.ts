export const PROC_STAT_1 = `cpu  10000 500 3000 80000 1000 0 200 300 0 0
cpu0 5000 250 1500 40000 500 0 100 150 0 0
intr 123456
ctxt 7890`;

/** +1000 total jiffies: user+600 system+150 idle+200 iowait+50 → 75% busy, 5% iowait. */
export const PROC_STAT_2 = `cpu  10600 500 3150 80200 1050 0 200 300 0 0
cpu0 5300 250 1575 40100 525 0 100 150 0 0`;

export const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:    4096000 kB
Buffers:          512000 kB
Cached:          2048000 kB
SwapCached:            0 kB
Shmem:            128000 kB
SReclaimable:     256000 kB
SwapTotal:       2048000 kB
SwapFree:        1536000 kB
HugePages_Total:       0`;

export const MEMINFO_NO_AVAILABLE = `MemTotal:       1000000 kB
MemFree:         100000 kB
Buffers:          50000 kB
Cached:          200000 kB
Shmem:            20000 kB
SReclaimable:     30000 kB`;

export const PROC_MOUNTS = `sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sdb1 /var/lib/postgresql xfs rw 0 0
/dev/sdc1 /mnt/with\\040space ext4 rw 0 0
tmpfs /run tmpfs rw 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0
/dev/loop0 /snap/core/123 squashfs ro 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sda1 /etc/hostname ext4 rw,relatime 0 0`;
