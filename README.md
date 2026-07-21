# swamp-gmail-read

[swamp](https://swamp.club) extension `@mgreten/gmail-read` — a read-only
Gmail reader (list recent/unread messages). No write methods by design.

📖 **Extension documentation:** [extensions/models/README.md](extensions/models/README.md)

📦 **Install:** `swamp extension pull @mgreten/gmail-read`

## Repository layout

This repository is a swamp workspace (its own `.swamp.yaml` repo). The
publishable extension lives under [extensions/models/](extensions/models/):

```
swamp-gmail-read/
  extensions/
    models/
      gmail_read.ts        # model implementation
      gmail_read_test.ts   # unit tests
      manifest.yaml        # swamp extension manifest
      README.md            # extension documentation
      LICENSE.txt           # MIT license
  README.md                 # this file
```

## License

MIT — see [extensions/models/LICENSE.txt](extensions/models/LICENSE.txt).
