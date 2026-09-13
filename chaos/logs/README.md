# chaos/logs/

This directory stores JSONL flight-recorder logs from chaos runs.

Each file is named `chaos-{epoch-ms}.jsonl`. Files are gitignored.
Use `.\scripts\run-chaos.ps1` to generate a new one.

To re-run the checker against an existing log without re-running the cluster:

```powershell
cd d:\Projects\Vulcan
npx --prefix chaos ts-node chaos/src/checker.ts chaos/logs/chaos-TIMESTAMP.jsonl
```
