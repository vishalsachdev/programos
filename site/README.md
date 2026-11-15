# Site

The public page for ProgramOS. `public/` is the only folder that is deployed.

- Preview: open `public/index.html` in a browser. The page has no build step and no JavaScript.
- Check what a deploy would send: `./site/deploy.sh --dry-run`
- Deploy: `./site/deploy.sh` (Cloudflare Pages, through `wrangler`)

Every fact on the page repeats a statement in `README.md` or `SPEC.md`. When one of those changes, change the page in the same commit.
