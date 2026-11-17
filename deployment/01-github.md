# Step 1 -- Push the code to GitHub

Repo: https://github.com/sonuengineer/Project_LLD_HLD (branch `main`)

## What was done

1. Checked before committing:
   - No real `.env` files (only `.env.example` with placeholders).
   - Secret scan of all staged files (AWS keys, Stripe/Razorpay live keys, private keys, GitHub tokens): nothing found.
   - Excluded: `.venv/`, `node_modules/`, `dist/`, `*.egg-info/`, `*.tsbuildinfo`, `portfolio/public/data` (generated at build time).
2. Added `.gitattributes` with `* text=auto eol=lf`.
   Why: Windows git (`core.autocrlf=true`) would otherwise commit CRLF line endings, and shell scripts / Dockerfiles
   with CRLF break on Linux (`/bin/sh^M: bad interpreter`).
3. `git init -b main`, one initial commit, then pushed.

## Problem hit: 403 on push

```
remote: Permission to sonuengineer/Project_LLD_HLD.git denied to <other-account>.
```

Cause: this PC has two GitHub accounts logged into `gh`; the active one is a different account, while `sonuengineer`
owns this repo. Git used the active account.

Fix (repo-local only, the global default account is unchanged):

```bash
git config --local credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper \
  '!f() { echo username=sonuengineer; echo "password=$(gh auth token --user sonuengineer)"; }; f'
```

The first line clears inherited helpers for github.com in this repo; the second asks `gh` for the `sonuengineer`
token at push time. No token is written to disk. From now on a plain `git push` in `H:\project` works.

## Day-to-day

```bash
git add <files>
git commit -m "message"
git push            # Vercel redeploys the portfolio automatically
```
