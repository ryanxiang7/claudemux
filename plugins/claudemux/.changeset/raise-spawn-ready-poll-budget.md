---
"claudemux": patch
---

raise `tm spawn`'s SessionStart readiness poll budget from 18s to 36s and rewrite the timeout WARN copy to describe what was actually observed instead of guessing a hook load failure
