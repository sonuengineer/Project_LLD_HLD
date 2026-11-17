# Step 2 -- Portfolio site on Vercel

Live: https://portfolio-beta-two-51.vercel.app (checked: page, `/data/index.json`, `/data/sources.json` all return 200)

## How the build works

The site needs `portfolio/public/data/` (interview banks + copied source files). That folder is NOT in git; it is
generated during the build by `interview/validate.py` (pure standard-library Python).

`portfolio/vercel.json`:

```json
{
  "framework": "vite",
  "installCommand": "npm ci",
  "buildCommand": "npm run data && npm run build",
  "outputDirectory": "dist"
}
```

`npm run data` runs `portfolio/scripts/data.mjs`, which looks for Python in this order:
repo `.venv` -> `$PYTHON` -> `python3` -> `python`. Vercel's build image has `python3`.

## Steps done in the Vercel dashboard

1. vercel.com -> Add New -> Project -> Import `sonuengineer/Project_LLD_HLD`.
2. Root Directory: `portfolio`.
3. Keep "Include files outside the root directory in the Build Step" ON (default). The build reads `../interview/`.
4. Deploy.

## Redeploys

Every `git push` to `main` triggers a new production deploy. Pull requests / other branches get preview URLs.

## If the build fails

| Symptom in the Vercel build log | Cause | Fix |
|---|---|---|
| `No Python interpreter found` | build image without Python | Project Settings -> Environment Variables -> `PYTHON=/usr/bin/python3` |
| `interview/validate.py: No such file` | "Include files outside root" is OFF | turn it back on |
| site loads but question pages are empty | `public/data` not generated | check that the build command is `npm run data && npm run build` |

## Custom domain (optional)

Project -> Settings -> Domains -> add your domain, then add the DNS record Vercel shows. HTTPS is automatic.
