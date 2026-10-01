# User preferences

- After completing and validating a requested change in this project, deploy it to production automatically. Do not stop at a local implementation or ask for deployment confirmation unless the user explicitly requests otherwise. This is the user's standing instruction from 2026-09-28.
- Deploy only the requested changes; preserve unrelated work in the shared workspace. Use an isolated release worktree when necessary.
- Production deploys through `git push prod HEAD:prod` (`prod` points to `cs:coinosv3.git`). The remote post-receive hook builds and publishes the site at https://v3.coinos.io. Verify the live assets and matching service-worker version after deployment.
