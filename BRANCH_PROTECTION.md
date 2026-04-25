# Branch Protection & Repository Security

This document explains how to protect the `main` branch and enforce code review standards.

---

## Why Protect the Main Branch?

- **Prevent accidental deletions** — main branch can't be force-pushed or deleted
- **Require code reviews** — all changes must go through pull requests
- **Enforce CI checks** — tests must pass before merge
- **Maintain release stability** — only tested, reviewed code reaches production

---

## Setting Up Branch Protection (GitHub)

### Step 1: Navigate to Repository Settings

1. Go to **GitHub.com** → your repository
2. Click **Settings** (top right)
3. In the left sidebar, click **Branches**
4. Click **Add rule** under "Branch protection rules"

### Step 2: Configure Protection for `main`

1. **Branch name pattern:** Enter `main`
2. Check the following boxes:

| Option | Purpose | Recommended |
|--------|---------|-------------|
| Require a pull request before merging | All changes via PR | ✅ **YES** |
| Require approvals | Prevent self-merge | ✅ **YES** (set to 1–2) |
| Require status checks to pass | Tests must pass | ✅ **YES** |
| Require branches to be up to date | Sync with main before merge | ✅ **YES** |
| Include administrators | Admins follow same rules | ✅ **YES** |
| Restrict who can push to matching branches | Lock main completely | ❌ Optional (for teams) |
| Allow force pushes | Allow rewriting history | ❌ **NO** |
| Allow deletions | Allow deleting branch | ❌ **NO** |

### Step 3: Require Status Checks

1. Check **Require status checks to pass before merging**
2. Under "Status checks that are required to pass", select:
   - `build` (or whatever your CI workflow is named)
   - `test` (if applicable)
   - Other key workflows

3. Check **Require branches to be up to date before merging**

### Step 4: Save

Click **Create** (or **Save changes** if updating)

---

## Example: Protected Main Branch Settings

```
Branch name pattern: main

✅ Require pull request reviews before merging
   - Required number of approvals: 1
   - Require review from code owners: (optional)
   - Dismiss stale pull request approvals: ✅

✅ Require status checks to pass before merging
   - Require branches to be up to date: ✅
   - Status checks: build, test

✅ Include administrators
✅ Require linear history (optional, for cleaner history)

❌ Allow force pushes
❌ Allow deletions
```

---

## Branch Protection via GitHub CLI

If you prefer to configure via CLI:

```bash
# Install GitHub CLI
# https://cli.github.com

# Login
gh auth login

# Add branch protection rule for main
gh api repos/sinhaankur/WatchTower/branches/main/protection \
  --method PUT \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build", "test"]
  },
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "enforce_admins": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
EOF
```

---

## Workflow: Developing with Branch Protection

### For Contributors

1. **Create a feature branch**
   ```bash
   git checkout -b feature/integrations-hub
   ```

2. **Make commits**
   ```bash
   git commit -m "Add Integrations page"
   ```

3. **Push to GitHub**
   ```bash
   git push origin feature/integrations-hub
   ```

4. **Create Pull Request**
   - Go to GitHub → Click **Compare & pull request**
   - Fill in title and description
   - Request reviewer (if configured)

5. **Wait for CI checks**
   - GitHub Actions runs automatically
   - Must pass all status checks (build, test)

6. **Get approval**
   - Wait for required review approvals
   - Reviewer can suggest changes via inline comments

7. **Merge**
   - Once approved and CI passes, click **Squash and merge** or **Merge pull request**
   - Your changes are now on `main` and deployed!

### For Repository Maintainers

1. **Review Pull Request**
   - Check code quality, test coverage, documentation
   - Leave inline comments if needed

2. **Approve**
   - Click **Review changes** → **Approve**
   - Confirm CI has passed

3. **Merge**
   - Click **Merge pull request**
   - Delete feature branch (optional, but recommended)

---

## Enforcing Code Quality

### Complement Branch Protection with CI/CD

Branch protection works best with automated checks. WatchTower includes:

**`.github/workflows/test.yml`** (if configured)
- Runs Python tests: `pytest tests/`
- Runs TypeScript checks: `npm run build`
- Validates requirements.txt

**`.github/workflows/lint.yml`** (if configured)
- Python linting: `flake8`, `black`
- TypeScript linting: `eslint`

These workflows are referenced in branch protection status checks.

---

## Temporary Admin Override

If you need to merge something **in an emergency bypassing protection:**

1. **As repository admin:**
   ```bash
   git push -f origin feature/emergency-fix:main
   ```
   ⚠️ **Use sparingly** — this defeats the purpose of protection

2. **Better approach: Create an emergency PR**
   - Request expedited review (tag maintainers)
   - Bypass is visible in commit history
   - Maintains accountability

---

## Removing Branch Protection (When Needed)

1. Go to **Settings** → **Branches**
2. Find your rule for `main`
3. Click **Delete** (danger icon)
4. Confirm

⚠️ **Recommended:** Leave main branch protected at all times.

---

## Best Practices

| Practice | Why | How |
|----------|-----|-----|
| **Require reviews** | Catches bugs, shares knowledge | 1–2 approvals minimum |
| **CI/CD required** | Prevents broken code on main | GitHub Actions checks |
| **Up-to-date required** | Avoids merge conflicts | Enable in protection settings |
| **Admin included** | Everyone follows same process | Check "Include administrators" |
| **Linear history** | Cleaner git history (optional) | Enable "Require linear history" |
| **Clear PR descriptions** | Context for reviewers | Template in `.github/pull_request_template.md` |

---

## Quick Checklist for Your Repository

- [ ] Enable branch protection on `main`
- [ ] Require 1–2 pull request reviews
- [ ] Require status checks (CI/CD) to pass
- [ ] Require branches to be up to date
- [ ] Include administrators in restrictions
- [ ] Disable force pushes and deletions
- [ ] Add PR template (optional, see below)

---

## Optional: Add Pull Request Template

Create `.github/pull_request_template.md`:

```markdown
## Description
Brief summary of changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## How Has This Been Tested?
Describe your testing process.

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have updated the documentation accordingly

## Screenshots (if applicable)
Add screenshots for UI changes.

## Related Issues
Closes #(issue)
```

---

## Troubleshooting

### "Cannot merge — status check failed"
- Wait for GitHub Actions to complete
- If failed, check the logs and fix the issue
- Push fixes to the same branch
- Status checks will re-run automatically

### "Cannot merge — requires review approval"
- Request review from a repository maintainer
- In PR, click **Reviewers** → select user
- Maintainer will review and approve

### "Branch protection says I can't force push"
- That's the point! Use `git rebase` instead
- Or create a new branch and new PR

---

## Further Reading

- [GitHub Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [GitHub Status Checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories/about-status-checks)
- [GitHub Actions](https://docs.github.com/en/actions)
