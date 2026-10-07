"""User-entered Atlas connection strings -> encrypted AWS SSM parameters.

Run interactively in AWS CloudShell. Credentials are hidden during entry, never
included in process arguments or printed, and existing parameters are preserved.
"""
import argparse
import getpass
import json
import pathlib
import subprocess
import tempfile
from urllib.parse import quote, urlsplit


def aws(region, operation, payload):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        path = pathlib.Path(handle.name)
        path.chmod(0o600)
        json.dump(payload, handle)
    try:
        result = subprocess.run(
            ["aws", "ssm", operation, "--region", region,
             "--cli-input-json", "file://" + str(path), "--output", "json"],
            capture_output=True, text=True,
        )
        if result.returncode:
            raise RuntimeError("SSM operation failed; inspect AWS permissions and parameter metadata. Secret values were not printed.")
        return json.loads(result.stdout or "{}")
    finally:
        path.unlink(missing_ok=True)


def configure(region, environment, host=None, replace=False, allow_username_password=False):
    name = f"/learnverse-tasks/{environment}/mongodb-uri"
    existing = aws(region, "describe-parameters", {
        "ParameterFilters": [{"Key": "Name", "Option": "Equals", "Values": [name]}]
    })["Parameters"]
    if existing:
        if existing[0]["Type"] != "SecureString":
            raise RuntimeError(f"Existing parameter has unexpected type: {name}")
        if not replace:
            print(f"Existing encrypted parameter preserved: {name}")
            return
    if host:
        if not host.endswith(".mongodb.net") or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in host):
            raise RuntimeError("Invalid Atlas hostname; nothing was saved.")
        username = f"learnverse_tasks_{environment}"
        password = getpass.getpass(f"Enter the NEW {environment} Atlas password for {username} (input hidden): ")
        if not password or (password == username and not allow_username_password):
            raise RuntimeError("A private password different from the username is required; nothing was saved.")
        uri = f"mongodb+srv://{username}:{quote(password, safe='')}@{host}/?appName=learnverse-tasks-{environment}"
        del password
    else:
        uri = getpass.getpass(f"Paste the complete {environment} Atlas driver URI (input hidden): ").strip()
    try:
        parsed = urlsplit(uri)
        valid = (parsed.scheme == "mongodb+srv" and parsed.username and parsed.password
                 and parsed.hostname and parsed.hostname.endswith(".mongodb.net")
                 and "<" not in uri and ">" not in uri
                 and all(c not in uri for c in "\r\n\t "))
    except ValueError:
        valid = False
    if not valid:
        raise RuntimeError("Invalid Atlas URI or unresolved placeholders; nothing was saved. URL-encode special characters in the password.")
    payload = {
        "Name": name, "Type": "SecureString", "Tier": "Standard", "Value": uri,
        "Description": f"LearnVerse Tasks {environment} Atlas database connection",
    }
    if existing:
        payload["Overwrite"] = True
    else:
        payload["Tags"] = [{"Key": "Project", "Value": "learnverse-tasks"},
                           {"Key": "Environment", "Value": environment}]
    aws(region, "put-parameter", payload)
    print(f"Saved encrypted Standard parameter: {name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("environment", choices=["dev", "prod", "both"])
    parser.add_argument("--region", default="ap-south-1")
    parser.add_argument("--dev-host")
    parser.add_argument("--prod-host")
    parser.add_argument("--replace", action="store_true", help="Replace existing encrypted connections after password rotation")
    parser.add_argument("--allow-username-password", action="store_true", help="Explicit owner override for a temporary existing password matching its username")
    arguments = parser.parse_args()
    for selected in ("dev", "prod") if arguments.environment == "both" else (arguments.environment,):
        configure(arguments.region, selected, getattr(arguments, selected + "_host"), arguments.replace, arguments.allow_username_password)
