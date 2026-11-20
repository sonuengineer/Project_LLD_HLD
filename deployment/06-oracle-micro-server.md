# Step 6 -- The Always Free micro server (works today, small)

The A1 (ARM, up to 4 CPU / 24 GB) was "Out of capacity", but Oracle's other free shape, the AMD micro, has its own
capacity pool and could be created right away. It is small, so it is a stepping stone, not the final server.

| | Micro (this step) | A1 (steps 3 and 5) |
|---|---|---|
| Shape | `VM.Standard.E2.1.Micro` | `VM.Standard.A1.Flex` |
| Chip | AMD x86_64 | ARM64 |
| Size | 1 OCPU / 1 GB RAM | 2-4 OCPU / 12-24 GB |
| Name used here | `portfolio-micro` | `portfolio-a1` |
| Good for | Caddy, one small app, practising the setup | NestJS + FastAPI + databases |

The two do not share a quota. Having the micro does not block the A1.

You can NOT turn a micro into an A1: different chip, so a different disk image. The A1 is always a new instance.

## 6.1 Why we recreated it instead of using the one made in the console

A first micro was created by hand in the console (default name `instance-YYYYMMDD-HHMM`). SSH was refused: the console
had attached a different SSH key than the one in `~/.ssh/oracle_portfolio`, and that key file was not found.
The instance was empty, so we deleted it and created a new one with our key. Lesson: when you create an instance by hand,
paste YOUR public key in the form (or save the key the console offers) -- the key cannot be added from outside later.

## 6.2 Create it with the script

`scripts/oci_micro_create.py` (uses the OCI SDK, `~/.oci/config`, and the same network as the A1 script):

```bash
# from H:\project\deployment\scripts, using the venv python
~/.oci-cli-venv/Scripts/python -I -u oci_micro_create.py
# to delete a hand-made micro first (only an exact name + micro shape is accepted, boot volume is deleted too):
~/.oci-cli-venv/Scripts/python -I -u oci_micro_create.py --replace instance-20261118-1027
```

What it does: (optionally terminates the named micro) -> reuses/creates `portfolio-vcn` + public subnet -> launches
Ubuntu 24.04 x86_64 with `oracle_portfolio.pub` -> waits for RUNNING -> prints the public IP. It succeeded on the first
attempt (about 1 minute to RUNNING). Output is appended to `micro-create.log` (git-ignored; it has resource IDs).

## 6.3 Log in and run the bootstrap script

```bash
ssh -i ~/.ssh/oracle_portfolio ubuntu@<MICRO_IP>
```

From your PC, copy and run the same script as for the A1 (it is architecture independent):

```bash
scp -i ~/.ssh/oracle_portfolio scripts/bootstrap-ubuntu.sh ubuntu@<MICRO_IP>:/tmp/bootstrap.sh
ssh -i ~/.ssh/oracle_portfolio ubuntu@<MICRO_IP> 'sed -i "s/\r$//" /tmp/bootstrap.sh && sudo bash /tmp/bootstrap.sh'
```

(`sed` strips Windows line endings if the file was saved with CRLF.)

## 6.4 Verify (what was actually checked)

```bash
ssh ... 'docker --version; caddy version; systemctl is-active caddy; swapon --show; sudo iptables -S INPUT | grep -E "dport (22|80|443)"'
curl -I http://<MICRO_IP>          # from your PC -> HTTP 200 (Caddy default page)
```

Result on 2026-11-18: Docker 29.10, Caddy 2.11.9 active, 4 GB swap, iptables allows 22/80/443, port 80 answers 200
from the internet (so both the VCN security list and the instance firewall are open). The public IP is kept out of this
file on purpose; it is printed by the script and shown in the Oracle console under Compute > Instances.

## 6.5 Limits to remember

- 1 GB RAM: one small service plus Caddy. Do not put databases and two backends here.
- The 4 GB swap prevents out-of-memory kills but is slow; treat it as a safety net.
- Images built for this box are x86_64. For the A1 (ARM64) build multi-arch images or rebuild on the A1.
- Idle reclaim: Oracle may reclaim Always Free instances with very low usage over 7 days; keep something running.

## 6.5b Run the A1 retry loop ON the micro (so the PC can be off)

Done on 2026-11-18. Steps (replace `<MICRO_IP>`):

```bash
K="-i $HOME/.ssh/oracle_portfolio"
ssh $K ubuntu@<MICRO_IP> 'sudo apt-get install -y python3-venv python3-pip; mkdir -p ~/oci-retry ~/.oci && chmod 700 ~/.oci; python3 -m venv ~/oci-retry/venv && ~/oci-retry/venv/bin/pip install oci'
scp $K scripts/oci_a1_grab.py ubuntu@<MICRO_IP>:~/oci-retry/
scp $K ~/.oci/config ~/.oci/oci_api_key.pem ubuntu@<MICRO_IP>:~/.oci/        # SECRET: the API private key
scp $K ~/.ssh/oracle_portfolio.pub ubuntu@<MICRO_IP>:~/.ssh/oracle_portfolio.pub   # public key given to the new A1
ssh $K ubuntu@<MICRO_IP> 'chmod 600 ~/.oci/config ~/.oci/oci_api_key.pem'
```

`~/.oci/config` uses `key_file=~/.oci/oci_api_key.pem`, so it works unchanged on the server. Then a systemd unit
`/etc/systemd/system/oci-a1-retry.service`:

```ini
[Unit]
Description=Retry Oracle A1 launch until capacity is available
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/oci-retry
ExecStart=/home/ubuntu/oci-retry/venv/bin/python -I -u oci_a1_grab.py --ocpus 2 --memory 12
Restart=on-failure
RestartSec=300
StandardOutput=append:/home/ubuntu/oci-retry/a1-retry.log
StandardError=append:/home/ubuntu/oci-retry/a1-retry.log
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now oci-a1-retry
systemctl status oci-a1-retry --no-pager          # active (running)
tail -n 5 ~/oci-retry/a1-retry.log                 # server clock is UTC
```

`Restart=on-failure` restarts it after a crash or reboot; when the script launches the A1 it exits with code 0, so the
service stays stopped. Success looks like `RUNNING. public IP: ...` in the log.

**Clean-up when the A1 exists (do not skip):** the API private key is on this server.

```bash
sudo systemctl disable --now oci-a1-retry
rm -f ~/.oci/oci_api_key.pem ~/.oci/config
```

Then delete the API key in the Oracle console (profile > My profile > API keys) and delete the local copy if unused.

## 6.7 Getting a SECOND A1 (2 OCPU / 12 GB more)

The Always Free A1 quota is 4 OCPU / 24 GB in total, so two 2 / 12 servers fit. After `portfolio-a1` existed, the same
loop was started again with a different name, run on the micro as a systemd service:

```bash
python -I -u oci_a1_grab.py --name portfolio-a2 --ocpus 2 --memory 12 --boot-gb 50
```

- `--name`: the script exits early if an instance with the default name `portfolio-a1` already exists, so a 2nd server needs its own name.
- `--boot-gb 50`: free block storage is 200 GB in TOTAL, boot volumes included. Boot volumes were micro 47 + A1 100 = 147 GB,
  leaving 53 GB, and the minimum boot size is 47 GB. Check what is used before you pick a size (the SDK lists boot volumes).
- In the systemd unit, `RestartPreventExitStatus=1` stops it from restarting forever when Oracle refuses for a reason
  other than capacity (for example a quota limit): the script exits with code 1 in that case.
- Result (2026-11-20): `portfolio-a2` launched, bootstrap applied, Docker `hello-world` ran on ARM, Caddy active, port 80
  answered 200. After it launched, the service was disabled and the API key was deleted from the micro (see the
  clean-up in 6.5b).
- Everything free is now used: A1 4 OCPU / 24 GB, disks 197 GB of 200 GB. Delete something before creating more.
- A new server is NOT automatically allowed by other services' firewalls (for example an Azure SQL firewall rule lists
  one IP). Add its public IP there if it must connect.

## 6.6 Moving to the A1 later

When `oci_a1_grab.py` prints `RUNNING. public IP: ...`, repeat 6.3 on the A1 (same script), deploy the apps per
`04-oracle-server-setup.md`, then decide whether to keep the micro as a small second server or delete it.
