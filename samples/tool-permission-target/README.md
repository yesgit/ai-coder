# Tool Permission Target

Small fixture project for validating AI Coder tool permission behavior with a live Claude Agent SDK run.

Expected smoke-test actions:

- read files inside this project
- request approval before running `npm test`
- request approval before editing `src/message.js`
- block attempts to read paths outside this project

