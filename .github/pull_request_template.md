## Summary

<!-- What changes and why. Link the issue it addresses, e.g. "Closes #123". -->

## Tests

<!-- How you tested it: new or updated tests, and anything you checked by hand. -->

## Checklist

- [ ] The change is focused on one thing and contains no unrelated changes.
- [ ] Tests cover the change, and `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
- [ ] Any new migration is committed with regenerated table types (`npm run db:migrate && npm run db:types`).
- [ ] Docs are updated where behavior or the API changed (README, `docs/`).
- [ ] Signed off (external contributors): every commit has a `Signed-off-by:` line naming its author (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/); see [CONTRIBUTING.md](https://github.com/cobaltmere/hourmere/blob/main/CONTRIBUTING.md#license-and-sign-off).
