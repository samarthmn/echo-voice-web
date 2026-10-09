# Release-site preview

These static sources prepare the approved `echovoice.samarthmn.com` home, download, privacy and support pages. They are **not published**, and no unavailable release or store URL is invented. Publisher facts come from [release/publisher.json](../release/publisher.json).

Run `node site/build.mjs` from the repository. It copies the actual shared tokens, bundled Inter fonts and Echo icon into `artifacts/site`, with four HTML pages and no executable browser code. Serve that directory through a local static server for review. The generated directory is not source and must not be committed.

Before hosting, Codex must reconcile the pages against the tested candidate, record the hosting provider and its request-log/retention behavior, settle support-message retention with the publisher, and verify actual downloads and assigned store identity. Replace branch documentation links with the qualified release's immutable URLs. Add web/extension artifact versions, checksums, local-server prerequisites and individual platform qualification results. Keep unavailable downloads as plain status text.

The build deliberately requires the current pending-publication status. When release is approved, update the status, this guard and page copy together; remove preview/noindex restrictions only as part of that reviewed change. Configure HTTPS, security headers and canonical redirects on the selected host. Publication, account agreements and store submission remain separate approved operations.
