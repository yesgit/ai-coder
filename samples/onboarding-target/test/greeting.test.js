import assert from "node:assert/strict";
import { greeting } from "../src/index.js";

assert.equal(greeting("AI Coder"), "Hello, AI Coder");
