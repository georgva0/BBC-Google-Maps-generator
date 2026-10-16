const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "site", "vendor");
const assets = [
    ["node_modules/d3/dist/d3.min.js", "d3.min.js"],
    ["node_modules/d3-geo-projection/dist/d3-geo-projection.min.js", "d3-geo-projection.min.js"],
    ["node_modules/topojson/dist/topojson.min.js", "topojson.min.js"],
];

fs.mkdirSync(output, { recursive: true });
for (const [source, filename] of assets) {
    fs.copyFileSync(path.join(root, source), path.join(output, filename));
}
