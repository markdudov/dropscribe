# 0013 — Try again on a file that can never work

## Symptom

Drop a video with no audio track. The job fails with the right sentence —
"…has no audio track, so there is nothing to transcribe." — and offers **Try
again**. Pressing it produces the identical sentence, word for word.

Measured: retrying such a job returned `identical: true` against the first
error, with no state change of any kind.

## Root cause

Not a missing mechanism. `JobError.retryable` exists, `JobRow` disables the
button when it is `false`, and eight failures in `queue.ts` already set it.

`probe()` threw a plain `Error`, so `describeFailure` fell through to its last
branch, which marks unknown failures retryable — deliberately, and for a good
reason it states:

> Offering a button that turns out not to help costs one wasted click;
> withholding it from somebody whose only problem was a half-open socket costs
> them the whole transcript.

That reasoning is right for unknown failures. The absence of an audio track is
not unknown; it is a property of the file, named precisely by the app itself.

## The fix

`MediaInputError` in `ffmpeg.ts`, thrown for a file with no audio track, and one
branch in `describeFailure` that marks it permanent. Deliberately narrow: the
other ffmpeg failure this could have covered — "Invalid data found when
processing input" — is left retryable, because a file can be replaced at the
same path and the existing policy should win wherever the answer is not certain.

## Test

Verified against the running app: three files enqueued together, and the
rendered buttons read back from the DOM.

```
  no-audio.mp4  failed  retryable=false  Try again: disabled
  liar.mp3      failed  retryable=true   Try again: ENABLED
  long.wav      done                     Try again: absent
```
