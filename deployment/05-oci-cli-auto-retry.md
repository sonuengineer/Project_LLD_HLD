# Step 3b -- Get the A1 server with the OCI CLI auto-retry (chosen option)

Why: the console form failed with "Out of capacity" (see `03-oracle-create-instance.md`). Free A1 capacity in
Mumbai appears in short bursts, so a script that retries every few minutes eventually gets one.

All commands below were run from Git Bash on this Windows PC. `~` = `C:\Users\Admin`.

## 1. Install the OCI CLI (own venv, does not touch the project venv)

```bash
"/c/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe" -m venv ~/.oci-cli-venv
~/.oci-cli-venv/Scripts/python -m pip install oci-cli
~/.oci-cli-venv/Scripts/oci --version
```

Python 3.11 is used because the CLI supports it well (the system 3.14 is very new). The install pulls many
packages and can take 10+ minutes on Windows.

Shortcut used in the rest of this file:

```bash
export OCI=~/.oci-cli-venv/Scripts/oci
```

## 2. Create an API key (lets the CLI act as your Oracle user)

```bash
mkdir -p ~/.oci && cd ~/.oci
openssl genrsa -out oci_api_key.pem 2048
openssl rsa -pubout -in oci_api_key.pem -out oci_api_key_public.pem
chmod 600 oci_api_key.pem
# fingerprint (must match what the console shows after upload)
openssl rsa -pubout -outform DER -in oci_api_key.pem | openssl md5 -c
```

- `oci_api_key.pem` = PRIVATE key. Never share, never commit. Anyone with it + the config can manage your account.
- `oci_api_key_public.pem` = public half, uploaded to Oracle.

## 3. Register the public key in the console

Console -> profile icon (top right) -> **My profile** -> **Tokens and keys** -> API keys -> **Add API key** ->
"Choose public key file" -> select `oci_api_key_public.pem` -> **Add**.

The console then shows a "Configuration file preview" with `user`, `fingerprint`, `tenancy`, `region`.
Fingerprint registered on 2026-11-17: `f8:cb:39:02:77:ae:66:6e:26:3a:70:5f:bb:33:e7:93`.

To revoke later: same page -> select the key -> Delete. The CLI stops working immediately.

## 4. Write `~/.oci/config`

Paste the preview from step 3 and add the key path:

```ini
[DEFAULT]
user=ocid1.user.oc1..<your user OCID>
fingerprint=<fingerprint>
tenancy=ocid1.tenancy.oc1..<your tenancy OCID>
region=ap-mumbai-1
key_file=~/.oci/oci_api_key.pem
```

```bash
chmod 600 ~/.oci/config
```

Test:

```bash
$OCI iam region-subscription list --query 'data[].{region:"region-name",home:"is-home-region"}' --output table
```

## 5. Faster path actually used: the OCI Python SDK

The CLI install took ~25 minutes on Windows (antivirus scans its thousands of files). The `oci` Python SDK it
depends on was installed early, so the remaining steps use one Python script instead of CLI commands:
[`scripts/oci_a1_grab.py`](scripts/oci_a1_grab.py). (`scripts/oci-create-network.sh` + `oci-retry-launch.sh` do the
same with the CLI, if you prefer shell.)

Test the key + config:

```bash
~/.oci-cli-venv/Scripts/python -c "
import oci
cfg=oci.config.from_file(); oci.config.validate_config(cfg)
idn=oci.identity.IdentityClient(cfg)
print('user ok:', idn.get_user(cfg['user']).data.lifecycle_state)
print('ADs:', [a.name for a in idn.list_availability_domains(cfg['tenancy']).data])
"
```

Result: `user ok: ACTIVE`, `ADs: ['foCn:AP-MUMBAI-1-AD-1']` (Mumbai has a single availability domain).

## 6. Create the network (one time)

```bash
cd /h/project/deployment/scripts
~/.oci-cli-venv/Scripts/python -I oci_a1_grab.py --network-only
```

What it creates (re-running reuses them):

| Resource | Name | Setting |
|---|---|---|
| VCN | `portfolio-vcn` | 10.0.0.0/16 |
| Internet gateway | `portfolio-igw` | enabled |
| Default route table | -- | 0.0.0.0/0 -> internet gateway |
| Default security list | -- | ingress TCP 22, 80, 443 from anywhere; ICMP 3/4; all egress |
| Subnet | `portfolio-public` | 10.0.0.0/24, public IPs allowed |

Result on 2026-11-17 11:07 IST: all created in ~7 seconds. Because ports 80/443 are opened here, the
"VCN Security List" part of `04-oracle-server-setup.md` section 4.1 is already done.

## 7. Start the retry loop

```bash
cd /h/project/deployment/scripts
~/.oci-cli-venv/Scripts/python -I -u oci_a1_grab.py >> ../a1-retry.log 2>&1 &
```

- Default: 4 OCPU / 24 GB / 100 GB disk, one attempt every 180 s. Smaller: `--ocpus 2 --memory 12`.
- The script refuses anything above the Always Free limits (4 OCPU / 24 GB / 200 GB).
- It exits by itself when the instance is RUNNING and prints the public IP (assigned automatically --
  no console quirk this time).
- If an instance named `portfolio-a1` already exists it just prints its IP and exits, so running it twice is safe.
- This PC must stay on (and not sleep) while it runs.

Watch progress:

```bash
tail -f /h/project/deployment/a1-retry.log
```

Typical log while waiting:

```
[2026-11-17 11:08:01] attempt 1: VM.Standard.A1.Flex 4 OCPU / 24 GB in foCn:AP-MUMBAI-1-AD-1
[2026-11-17 11:08:03]   no capacity (500 InternalError); retry in 180s
```

Stop it: close the terminal, or `taskkill //F //IM python.exe` (careful: kills all Python processes), or find
the PID with `tasklist | grep python`.

## 8. When it succeeds

The log ends with:

```
LAUNCHED ocid1.instance....
RUNNING. public IP: <IP>
```

Then continue with `04-oracle-server-setup.md` (section 4.2 onward).

## Clean-up / revoke (if you ever stop using this)

- Revoke the API key: Console -> My profile -> Tokens and keys -> API keys -> Delete.
- Delete `~/.oci/` on this PC.
- The network costs nothing; delete it from Networking -> Virtual cloud networks if unused.
