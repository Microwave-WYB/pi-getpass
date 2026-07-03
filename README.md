# pi-getpass

A pi package that adds a `getpass` tool for collecting secrets safely from the user.

![pi-getpass masked secret input](./screenshot.png)

When the agent needs an API key, token, password, or other secret, it calls `getpass` with an exact env var name like `OPENAI_API_KEY`. The package temporarily replaces the normal pi input UI with a masked secret input, stores the secret in `process.env` for the current pi process, and returns only the env var name to the model. The secret value is not written to chat/session history.

## What this is / is not

`pi-getpass` is a convenience tool for getting a secret from you without asking you to paste it into chat or manually write it into an `.env` file first.

It is **not** a secret-leakage guard or sandbox:

- It offers no passive protection after the secret is captured.
- It does not stop the agent, shell commands, other extensions, or child processes from reading or printing the env var.
- It does not redact outputs from tools like `env`, `printenv`, `set -x`, logs, or config files.
- It only provides a cleaner input path: masked TUI input → temporary env var → agent can use the env var name.

Use normal secret hygiene: do not echo secrets, avoid tracing, unset secrets when done, and review commands that consume them.

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

Do not echo or print the secret.

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
