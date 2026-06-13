# WatchTower legal documents

| Document | Purpose |
|---|---|
| [Terms of Use](TERMS_OF_USE.md) | Conditions for using a running installation: self-hosted responsibility, AI/automation disclaimer, no warranty, limitation of liability, indemnification |
| [Acceptable Use Policy](ACCEPTABLE_USE.md) | What the software may not be used for (illegal use, attacking third-party systems, harmful content, license circumvention) |
| [Privacy Policy](PRIVACY.md) | What the app stores locally, where data flows, operator responsibilities under data-protection law |

## How acceptance works

The **canonical copies live in `watchtower/legal_docs.py`** — that's what
the app serves and what users accept. These markdown files are
GitHub-readable mirrors; regenerate them after editing the module:

```bash
.venv/bin/python -c "
from watchtower.legal_docs import DOCUMENTS
names = {'terms':'TERMS_OF_USE.md','acceptable-use':'ACCEPTABLE_USE.md','privacy':'PRIVACY.md'}
[open(f'legal/{names[d[\"id\"]]}','w').write(d['content']) for d in DOCUMENTS]"
```

Every user must accept the current `TERMS_VERSION` before using the app:

1. The login screen states that signing in constitutes agreement (shown
   on **every** login).
2. After authentication, a blocking gate presents all three documents
   and requires an explicit "I agree" click before any other screen is
   reachable.
3. Each acceptance is recorded **append-only** in the `legal_acceptances`
   table (user, document version, timestamp, IP) and mirrored to the
   audit log — this is the evidentiary record that a given user agreed
   to a given version at a given time.
4. Bumping `TERMS_VERSION` in `legal_docs.py` re-gates every user on
   their next login. Bump it for material changes (new data flows, new
   autonomous behaviour, liability changes), not typo fixes.

Source-code licensing is separate: see `LICENSE` (Apache 2.0),
`pro/` (Elastic License 2.0), and `LICENSE-COMMERCIAL.md`.

> **Maintainer note:** these documents were drafted in good faith to
> protect the project but have **not** been reviewed by an attorney.
> Before a commercial launch, have counsel review them and pin the
> governing-law clause to a concrete jurisdiction.
