# Site

The public site for ProgramOS. Both pages use the neutral palette in `public/theme.css`. Update that file to rebrand a clone.

- Serve a local preview with `python3 -m http.server 8000 --bind 127.0.0.1 --directory site/public`. Open `http://127.0.0.1:8000/` or `http://127.0.0.1:8000/404.html`.
- Run `./site/deploy.sh --dry-run` to list the upload files without sending them.
- Deploy to Cloudflare Pages with `PAGES_PROJECT=<your-project> ./site/deploy.sh`.
- For the Illinois deployment, run `SITE_THEME=illinois ./site/deploy.sh`. This stages the Illinois palette from `themes/illinois.css` as `theme.css` for both pages. Use `--dry-run` to inspect the upload list for that theme.

Every fact on the page repeats a statement in `README.md` or `SPEC.md`. When one of those changes, change the page in the same commit.
