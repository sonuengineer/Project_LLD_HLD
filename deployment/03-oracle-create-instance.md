# Step 3 -- Create the Oracle A1 server

Account: Oracle Cloud Free Trial (becomes "Always Free" after the trial), home region India West (Mumbai).

## Target configuration (all inside Always Free)

| Setting | Value | Why |
|---|---|---|
| Name | `portfolio-a1` | |
| Image | Canonical Ubuntu 24.04 (the ARM/aarch64 build is picked automatically for A1) | Docker + Caddy install cleanly |
| Shape | VM.Standard.A1.Flex, 4 OCPU / 24 GB (fallback 2/12 or 1/6) | Always Free allows 4 OCPU + 24 GB total for A1 |
| Network | New VCN + new public subnet (10.0.0.0/24) | |
| Public IPv4 | attach after creation (see below) | the new console form will not enable it for a not-yet-created subnet |
| SSH key | paste `C:\Users\Admin\.ssh\oracle_portfolio.pub` | |
| Boot volume | 100 GB, 10 VPU | Always Free allows 200 GB block storage total; 10 VPU = free performance level |

## Click-by-click

1. Console -> Compute -> Instances -> **Create instance**. (screenshot `01-instances-empty.png` = state before)
2. **Basic information**: Name `portfolio-a1`, compartment = root.
   - Change image -> Ubuntu -> **Canonical Ubuntu 24.04** -> Select image. (`02-image-ubuntu-2404.png`)
   - Change shape -> Virtual machine -> **Ampere** -> `VM.Standard.A1.Flex` -> expand the row ->
     OCPUs `4`, memory `24` -> Select shape. (`03-shape-4ocpu-24gb.png`)
   - WATCH OUT: those number boxes APPEND what you type. Typing `4` into a box that shows `1` gave `14`
     (a paid size). Select all (Ctrl+A) first, then type. Always re-read the "Shape build" line before Create:
     it must say `4 core OCPU, 24 GB memory` (or your fallback size).
   - Do NOT pick E3/E4/E5 Flex or E2.1/E2.2: those are paid.
3. **Security**: leave defaults (shielded instance off).
4. **Networking**: Primary network -> **Create new virtual cloud network**, subnet -> **Create new public subnet**.
   The "Automatically assign public IPv4 address" switch stays greyed out with the warning
   "You must select a public subnet" (`06-public-ip-switch-disabled.png`). That is a console quirk -- attach the
   public IP after creation (step 5 below).
   - Add SSH keys -> **Paste public key** -> paste the single line from `oracle_portfolio.pub`.
5. **Storage**: "Specify a custom boot volume size" ON -> `100` GB, VPU `10`.
6. **Review** -> **Create**.

## What happened on 2026-11-17

All three sizes failed with:

```
API Error: Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1.
Create the instance in a different availability domain or try again later.
```

(`05-out-of-capacity.png`; `04-shape-2ocpu-12gb.png` shows the 2 OCPU retry.)
Tried 4/24, 2/12, 1/6 -- all refused. Mumbai has only ONE availability domain, so "try another AD" is not possible.
Checked afterwards: no instance and no VCN were left behind.

This is normal for free A1 in busy regions: Oracle only gives free ARM capacity when some is idle.

## Ways around the capacity error (pick one)

| Option | Effort | Cost | Notes |
|---|---|---|---|
| A. Retry manually | low | free | Try the same form at different times (early morning IST often works). Capacity appears in bursts. |
| B. Auto-retry script | medium | free | `scripts/oci-retry-launch.sh` retries every few minutes until a launch succeeds. Needs the OCI CLI + an API key (setup in the script header). |
| C. Upgrade to Pay As You Go | low | free if you stay in Always Free limits | Needs a card. PAYG accounts get A1 capacity far more reliably. Set a Budget alert (e.g. 1 USD) right after upgrading so any accidental paid resource emails you. |

Recommendation: C if you are OK adding a card (fastest and most reliable), otherwise B.
Note: the home region (Mumbai) cannot be changed, and Always Free A1 is only available in the home region.

## Step 5 -- after the instance is RUNNING: attach the public IP

1. Instances -> `portfolio-a1` -> Networking tab -> Attached VNICs -> primary VNIC.
2. IP administration / IPv4 addresses -> the private IP row -> **Edit** -> Public IP type: **Ephemeral public IP** -> Update.
3. Copy the public IP. Continue with `04-oracle-server-setup.md`.

(An ephemeral IP stays the same as long as the instance is not terminated. A "Reserved public IP" survives
re-creating the instance; the free tier includes a small number of them.)
