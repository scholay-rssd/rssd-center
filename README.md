# RSSD Center

RSSD Center brings a shared demand pool, multilingual works, article editing and device coordination into the existing Postiz product. It is based on Postiz **v2.25.1** and keeps its authentication and publishing integrations.

This branch is an implementation checkpoint. The work library, claim protocol, scoped credentials, editor and durable submission handling are implemented and tested. Destination dispatch, site migration, backup integration and final production acceptance remain in progress. A queued publication is not a published post.

- [Architecture, interfaces and verification](rssd/README.md)
- [RSSD core](https://github.com/scholay-rssd/rssd)
- [Original Postiz documentation](README.postiz.md)
- [AGPL-3.0 license](LICENSE)

The RSSD protocol dependency retains its separate [MIT license](rssd/PROTOCOL-LICENSE). Existing upstream and third-party notices remain in place. RSSD-specific CI uses synthetic data and an isolated PostgreSQL service; the original upstream workflows are retained under `rssd/upstream-workflows/` as inactive reference material.
