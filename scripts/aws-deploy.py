"""Run in authenticated AWS CloudShell or an authenticated local AWS CLI.

Every stack mutation creates and inspects a change set before execution.
No MongoDB URI is accepted in command arguments or written to release records.
"""
import argparse
import hashlib
import json
import mimetypes
import pathlib
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent


def aws(service, operation, **payload):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = pathlib.Path(f.name)
        json.dump(payload, f)
    try:
        path.chmod(0o600)
        result = subprocess.run(["aws", service, operation, "--region", REGION,
                                 "--cli-input-json", "file://" + str(path), "--output", "json"],
                                capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return json.loads(result.stdout or "{}")
    finally:
        path.unlink(missing_ok=True)


def stack(name):
    try:
        result = aws("cloudformation", "describe-stacks", StackName=name)["Stacks"][0]
        return None if result["StackStatus"] == "REVIEW_IN_PROGRESS" else result
    except RuntimeError as e:
        if "does not exist" in str(e):
            return None
        raise


def outputs(value):
    return {x["OutputKey"]: x["OutputValue"] for x in value.get("Outputs", [])}


def change(name, template, parameters):
    existing = stack(name)
    if existing and existing["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"):
        raise RuntimeError("Stack needs attention: " + existing["StackStatus"])
    change_name = "release-" + secrets.token_hex(6)
    aws("cloudformation", "create-change-set", StackName=name, ChangeSetName=change_name,
        ChangeSetType="UPDATE" if existing else "CREATE", Capabilities=["CAPABILITY_IAM"],
        TemplateBody=template.read_text(encoding="utf-8"), Parameters=parameters,
        Tags=[{"Key": "Project", "Value": "learnverse-tasks"}])
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        proposal = aws("cloudformation", "describe-change-set", StackName=name, ChangeSetName=change_name)
        if proposal["Status"] in ("CREATE_COMPLETE", "FAILED"):
            break
        time.sleep(3)
    else:
        raise RuntimeError("Change set still pending: " + change_name)
    if proposal["Status"] == "FAILED":
        reason = proposal.get("StatusReason", "")
        if "didn't contain changes" in reason or "No updates are to be performed" in reason:
            return outputs(existing)
        raise RuntimeError(reason)
    changes = [x["ResourceChange"] for x in proposal["Changes"]]
    for c in changes:
        print(json.dumps({k: c.get(k) for k in ("Action", "LogicalResourceId", "ResourceType", "Replacement")}))
    (ROOT / "output").mkdir(exist_ok=True)
    (ROOT / "output" / (name + "-changes.json")).write_text(json.dumps(changes, indent=2))
    # Code/origin updates may change Lambda while preserving its named identity.
    # CloudFormation propagates ApiFunction.Arn as an unknown dynamic value to
    # the URL, even though this explicitly named function is not replaced.
    # Accept only that exact URL dependency with unchanged URL properties,
    # function name and environment identity. All other replacements are blocked.
    reviewed_url_dependency = False
    reviewed_smtp_permission = False
    if existing:
        old_params = {p["ParameterKey"]: p.get("ParameterValue") for p in existing["Parameters"]}
        new_params = {p["ParameterKey"]: p.get("ParameterValue", old_params.get(p["ParameterKey"])) for p in parameters}
        if new_params.get("Environment") == old_params.get("Environment"):
            original = aws("cloudformation", "get-template", StackName=name)["TemplateBody"]
            if isinstance(original, str):
                original = json.loads(original)
            proposed = json.loads(template.read_text(encoding="utf-8"))
            # This opt-in is only for the reviewed Gmail reset-mail parameter.
            # It cannot authorize any other IAM permission or role change.
            if globals().get("REVIEW_SMTP_ACCESS", False):
                original_role = original["Resources"]["ApiRole"]
                expected_role = json.loads(json.dumps(original_role))
                smtp_statement = {"Effect": "Allow", "Action": "ssm:GetParameter", "Resource": {"Fn::Sub": "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/learnverse-tasks/${Environment}/smtp"}}
                statements = expected_role["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
                if smtp_statement not in statements:
                    statements.append(smtp_statement)
                reviewed_smtp_permission = proposed["Resources"]["ApiRole"] == expected_role and all(c["LogicalResourceId"] == "ApiRole" and c["Action"] == "Modify" and c.get("Replacement") == "False" for c in changes if c["ResourceType"].startswith("AWS::IAM::"))
            function_changes = [c for c in changes if c["LogicalResourceId"] == "ApiFunction"]
            url_changes = [c for c in changes if c["LogicalResourceId"] == "ApiUrl"]
            if original["Resources"]["ApiUrl"] == proposed["Resources"]["ApiUrl"] and original["Resources"]["ApiFunction"]["Properties"]["FunctionName"] == proposed["Resources"]["ApiFunction"]["Properties"]["FunctionName"] and len(function_changes) == 1 and function_changes[0].get("Replacement") == "False" and len(url_changes) == 1:
                details = url_changes[0].get("Details", [])
                reviewed_url_dependency = len(details) == 1 and details[0].get("Evaluation") == "Dynamic" and details[0].get("ChangeSource") == "ResourceAttribute" and details[0].get("CausingEntity") == "ApiFunction.Arn" and details[0].get("Target", {}).get("Name") == "TargetFunctionArn"
    if existing and any(c["Action"] == "Remove" or c.get("Replacement") == "True" or (c.get("Replacement") == "Conditional" and not (reviewed_url_dependency and c["LogicalResourceId"] == "ApiUrl")) for c in changes):
        raise RuntimeError("Unexpected replacement/removal; change set was not executed")
    if existing and any(c["ResourceType"].startswith("AWS::IAM::") for c in changes) and not reviewed_smtp_permission:
        raise RuntimeError("IAM update needs explicit review; change set was not executed")
    if not EXECUTE:
        print("Prepared change set:", change_name)
        raise SystemExit("Review complete. Rerun with --execute after reviewing the proposed resources.")
    aws("cloudformation", "execute-change-set", StackName=name, ChangeSetName=change_name)
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        live = stack(name)
        status = live["StackStatus"]
        if status in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
            aws("cloudformation", "update-termination-protection", StackName=name, EnableTerminationProtection=True)
            return outputs(live)
        if "FAILED" in status or "ROLLBACK" in status:
            events = aws("cloudformation", "describe-stack-events", StackName=name)["StackEvents"]
            failures = [{k: e.get(k) for k in ("LogicalResourceId", "ResourceStatus", "ResourceStatusReason")}
                        for e in events if "FAILED" in e["ResourceStatus"]]
            print(json.dumps(failures, indent=2))
            raise RuntimeError("Deployment failed: " + status)
        print(name, status, flush=True)
        time.sleep(15)
    raise RuntimeError("Stack still in progress; inspect AWS before retrying")


def fetch(path, headers=None):
    request = urllib.request.Request(path, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=35) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def verify(url, distribution):
    config = aws("cloudfront", "get-distribution-config", Id=distribution)["DistributionConfig"]
    if config.get("WebACLId"):
        raise RuntimeError("Unexpected WAF association")
    for behavior in config["CacheBehaviors"]["Items"]:
        assert behavior["CachePolicyId"] == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    for path in ("/", "/projects/example"):
        status, headers, body = fetch(url + path, {"Accept": "text/html"})
        assert status == 200 and b'<div id="root"' in body, (path, status)
    for asset in (ROOT / "dist" / "assets").rglob("*"):
        if asset.is_file():
            status, headers, body = fetch(url + "/assets/" + asset.relative_to(ROOT / "dist" / "assets").as_posix())
            assert status == 200 and hashlib.sha256(body).digest() == hashlib.sha256(asset.read_bytes()).digest(), asset.name
            kind = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
            if asset.suffix == ".js":
                assert "javascript" in kind, kind
            if asset.suffix == ".css":
                assert "text/css" in kind, kind
    status, _, body = fetch(url + "/assets/definitely-missing.js")
    assert status in (403, 404) and b'<div id="root"' not in body
    status, headers, body = fetch(url + "/api/v1/health")
    assert status == 200 and json.loads(body)["ok"]
    assert any(k.lower() == "cache-control" and "no-store" in v for k, v in headers.items())
    assert fetch(url + "/api/v1/workspace")[0] == 401
    request = urllib.request.Request(url + "/api/v1/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(), headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        urllib.request.urlopen(request, timeout=35)
        raise RuntimeError("MCP accepted an unauthenticated request")
    except urllib.error.HTTPError as e:
        assert e.code == 401, ("MCP endpoint unavailable", e.code)
    print("Verified HTTPS, DB health, assets, SPA routing, API/MCP authentication rejection, no-store API, and no WAF.")


def deploy(environment):
    (ROOT / "output").mkdir(exist_ok=True)
    manifest = json.loads((ROOT / "release.json").read_text(encoding="utf-8-sig"))
    package = ROOT / "api.zip"
    if hashlib.sha256(package.read_bytes()).hexdigest() != manifest["apiSha256"]:
        raise RuntimeError("API package does not match the release manifest")
    param_name = "/learnverse-tasks/" + environment + "/mongodb-uri"
    # Check metadata only: the MongoDB connection string never enters this process.
    parameters = aws("ssm", "describe-parameters", ParameterFilters=[{"Key": "Name", "Option": "Equals", "Values": [param_name]}])["Parameters"]
    if not parameters or parameters[0]["Type"] != "SecureString":
        raise RuntimeError("Create a Standard SecureString SSM parameter first: " + param_name)
    account = aws("sts", "get-caller-identity")["Account"]
    print("Account:", account, "Region:", REGION, "Environment:", environment)
    artifacts = change("learnverse-tasks-artifacts", ROOT / "infra/aws/artifacts.json", [])
    bucket = artifacts["ArtifactBucket"]
    subprocess.run(["aws", "s3", "cp", str(package), "s3://" + bucket + "/" + manifest["apiKey"], "--region", REGION, "--only-show-errors"], check=True)
    assert aws("s3api", "head-object", Bucket=bucket, Key=manifest["apiKey"])["ContentLength"] == package.stat().st_size
    name = "learnverse-tasks-" + environment
    existing = stack(name)
    previous = outputs(existing) if existing else {}
    old_parameters = {p["ParameterKey"]: p.get("ParameterValue", "") for p in existing.get("Parameters", [])} if existing else {}
    values = {"Environment": environment, "ArtifactBucket": bucket, "ApiCodeKey": manifest["apiKey"], "MongoParameterName": param_name, "AppOrigin": old_parameters.get("AppOrigin") or previous.get("CloudFrontUrl", previous.get("WebsiteUrl", ""))}
    params = [{"ParameterKey": k, "ParameterValue": v} for k, v in values.items()]
    params.append({"ParameterKey": "OriginToken", "UsePreviousValue": True} if existing else {"ParameterKey": "OriginToken", "ParameterValue": secrets.token_hex(32)})
    for key in ("CustomDomainName", "ViewerCertificateArn", "DomainHostedZoneId", "PublishDomainDns", "ActivateCustomDomain"):
        if key in old_parameters:
            params.append({"ParameterKey": key, "UsePreviousValue": True})
    # Save parameter names and artifact identity only, without secrets.
    if existing:
        old_key = next(x["ParameterValue"] for x in existing["Parameters"] if x["ParameterKey"] == "ApiCodeKey")
        (ROOT / "output" / (name + "-rollback.json")).write_text(json.dumps({"apiKey": old_key, "outputs": previous}, indent=2))
    live = change(name, ROOT / "infra/aws/environment.json", params)
    if not existing:
        for p in params:
            if p["ParameterKey"] == "AppOrigin":
                p["ParameterValue"] = live["WebsiteUrl"]
            elif p["ParameterKey"] == "OriginToken":
                p.pop("ParameterValue", None)
                p["UsePreviousValue"] = True
        live = change(name, ROOT / "infra/aws/environment.json", params)
    # Preserve existing hashed assets and S3 versions. Publish assets before index.html.
    for asset in (ROOT / "dist").rglob("*"):
        if not asset.is_file() or asset.name == "index.html":
            continue
        key = asset.relative_to(ROOT / "dist").as_posix()
        mime = {".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json"}.get(asset.suffix, mimetypes.guess_type(asset.name)[0] or "application/octet-stream")
        cache = "public,max-age=31536000,immutable" if key.startswith("assets/") else "no-cache"
        subprocess.run(["aws", "s3", "cp", str(asset), "s3://" + live["WebBucket"] + "/" + key, "--region", REGION, "--content-type", mime, "--cache-control", cache, "--only-show-errors"], check=True)
    if existing:
        version = aws("s3api", "head-object", Bucket=live["WebBucket"], Key="index.html").get("VersionId")
    else:
        version = None
    subprocess.run(["aws", "s3", "cp", str(ROOT / "dist/index.html"), "s3://" + live["WebBucket"] + "/index.html", "--region", REGION, "--content-type", "text/html", "--cache-control", "no-cache", "--only-show-errors"], check=True)
    invalidation = aws("cloudfront", "create-invalidation", DistributionId=live["DistributionId"], InvalidationBatch={"Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": secrets.token_hex(12)})["Invalidation"]["Id"]
    subprocess.run(["aws", "cloudfront", "wait", "invalidation-completed", "--distribution-id", live["DistributionId"], "--id", invalidation, "--region", REGION], check=True)
    verify(live["WebsiteUrl"], live["DistributionId"])
    record = {"environment": environment, "region": REGION, "account": account, "apiKey": manifest["apiKey"], "frontendPreviousIndexVersion": version, **live}
    (ROOT / "output" / (environment + "-deployment.json")).write_text(json.dumps(record, indent=2))
    print(live["WebsiteUrl"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("environment", choices=["dev", "prod"])
    parser.add_argument("--region", default="ap-south-1")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--review-smtp-access", action="store_true", help="Allow only the reviewed GetParameter permission for this environment's reset-mail credential")
    args = parser.parse_args()
    REVIEW_SMTP_ACCESS = args.review_smtp_access
    REGION, EXECUTE = args.region, args.execute
    deploy(args.environment)
