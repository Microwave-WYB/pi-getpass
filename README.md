# pi-getpass

A pi package that adds a `getpass` tool for collecting secrets safely from the user.

![pi-getpass masked secret input](./screenshot.png)

When the agent needs an API key, token, password, or other secret, it calls `getpass` with an exact env var name like `OPENAI_API_KEY`. The package temporarily replaces the normal pi input UI with a masked secret input, stores the secret in `process.env` for the current pi process, and returns only the env var name to the model. The secret value is not written to chat/session history.

## What this is / is not

`pi-getpass` is a convenience tool for getting a secret from you without asking you to paste it into chat or manually write it into an `.env` file first.

It is **not** a sandbox:

- It does not stop the agent, shell commands, other extensions, or child processes from reading the env var.
- It cannot prevent a process from writing a secret directly to external logs, files, or services.
- Redaction applies to tool output and `!`/`!!` shell output visible through pi, including streaming and finalized results.
- Tool-call arguments are not rewritten, since changing them could break commands that intentionally consume the secret through shell expansion.
- It only tracks values collected by `getpass` in the current extension runtime; pre-existing environment variables are not redacted.
- Reloading or restarting pi clears the tracked-value set. Recollect a disposable value before each redaction test.
- Redaction matches contiguous, exact plaintext values; encoded or transformed variants are not detected.

Use normal secret hygiene: avoid tracing, unset secrets when done, and review commands that consume them. Tracked secret values appearing in pi-visible tool output are replaced with `****`.

## Install

```bash
pi install git:github.com/Microwave-WYB/pi-getpass
```

For local development from a clone:

```bash
git clone https://github.com/Microwave-WYB/pi-getpass.git
cd pi-getpass
pi install .
# or for one run only:
pi -e .
```

## Tools

### `getpass`

Collect a secret and store it in a temporary env var.

Parameters:

- `envVar` — exact env var name to populate, e.g. `OPENAI_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`
- `overwrite` — allow replacing an existing env var of the same name; default `false`
- `prompt` — text shown to the user
- `allowEmpty` — allow an empty secret

Example agent flow:

1. Call `getpass` with `{ "envVar": "OPENAI_API_KEY", "prompt": "Enter your OpenAI API key" }`.
2. Use `$OPENAI_API_KEY` in later `bash` calls, for example:

```bash
printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> .env
```

Avoid echoing or printing real secrets. For redaction testing, use a disposable test value.

### `getpass_list`

List env var names populated by `getpass` in the current pi runtime. Returns names only, never values.

### `getpass_unset`

Unset a getpass env var from the current pi process:

```json
{ "envVar": "OPENAI_API_KEY" }
```

## Commands

```text
/getpass OPENAI_API_KEY
/getpass-list
/getpass-unset OPENAI_API_KEY
```

Variables are temporary and last only for the current pi process/session runtime, unless explicitly written somewhere by a later command.

## Verify redaction

Use a disposable value, never a real credential:

1. Run `/getpass PI_GETPASS_TEST` and enter `hello` in the masked prompt.
2. Run `!echo "$PI_GETPASS_TEST"` to test the direct `!` shell path.
3. Ask the agent to run `echo "$PI_GETPASS_TEST"` to test tool output.

Both outputs should display `****`. Run `/getpass` again after `/reload` or a restart because tracking is intentionally runtime-local.
