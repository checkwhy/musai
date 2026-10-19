const { readFileSync } = require("node:fs");
process.exit(JSON.parse(readFileSync("greeting.json", "utf8")).greeting === "hello" ? 0 : 1);
