---
"executor": patch
---

**Fix: the artifact migration no longer narrows `definition.name` to varchar(255), which failed on existing long definition names**
