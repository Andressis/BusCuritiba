const fs = require("fs");
const path = require("path");

const rootDirectory = __dirname;
const versionFile = path.join(rootDirectory, "version.json");
const htmlFile = path.join(rootDirectory, "frontend", "index.html");

const { version } = JSON.parse(fs.readFileSync(versionFile, "utf8"));

if (typeof version !== "string" || version.trim() === "") {
  throw new Error("version.json must contain a non-empty string in \"version\".");
}

let html = fs.readFileSync(htmlFile, "utf8");
const versionComment = /<!--\s*Version\s*=\s*v[^>]*-->/i;

if (!versionComment.test(html)) {
  throw new Error(`Version comment not found in ${htmlFile}.`);
}

html = html.replace(versionComment, `<!-- Version = v${version} -->`);

let updatedAssets = 0;
const assetAttribute = /(\b(?:href|src)=["'])([^"']+)(["'])/gi;

html = html.replace(assetAttribute, (match, prefix, assetUrl, suffix) => {
  const [pathAndQuery, hash = ""] = assetUrl.split("#", 2);
  const queryIndex = pathAndQuery.indexOf("?");
  const assetPath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : pathAndQuery.slice(queryIndex + 1);
  const isExternal = /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(assetPath);

  if (isExternal || !/\.(?:css|js)$/i.test(assetPath)) {
    return match;
  }

  const queryParameters = query ? query.split("&") : [];
  const versionParameterIndex = queryParameters.findIndex((parameter) => /^v=/i.test(parameter));

  if (versionParameterIndex === -1) {
    queryParameters.push(`v=${encodeURIComponent(version)}`);
  } else {
    queryParameters[versionParameterIndex] = `v=${encodeURIComponent(version)}`;
  }

  updatedAssets += 1;
  return `${prefix}${assetPath}?${queryParameters.join("&")}${hash}${suffix}`;
});

if (updatedAssets === 0) {
  throw new Error(`No local CSS or JS assets found in ${htmlFile}.`);
}

fs.writeFileSync(htmlFile, html, "utf8");
