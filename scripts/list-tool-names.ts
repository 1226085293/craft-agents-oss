import { getSessionToolProxyDefs } from '../packages/shared/src/agent/backend/pi/session-tool-defs.ts';
const defs = getSessionToolProxyDefs();
console.log('COUNT=' + defs.length);
defs.forEach((d) => console.log(d.name.replace('mcp__session__', '')));