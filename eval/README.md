# Classifier evaluation set

Put labelled photos here, one folder per label:

```
eval/photos/
  smoke/  dust/  haze/  fire/     <- should be flagged as pollution
  clear/  unclear/                 <- should NOT be flagged
```

(`pollution/` and `no_pollution/` also work for a binary-only set.)

Then run:

```bash
GEMINI_API_KEY=... npm run eval:classifier
```

This runs the exact production prompt and parser (`lib/geminiClassifier.ts`) and
writes `public/eval/classifier-eval.json`, which the dashboard Model quality card
shows. Use photos you have the right to use, and keep test photos out of any
prompt tuning so the numbers stay honest. Photos in this folder are gitignored.
