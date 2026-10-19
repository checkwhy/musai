import type { EnvelopeRequest, InvokedContribution } from "../../src/rule/envelope.js";
import { InProcessHost, type InvocationLimits } from "../../src/rule/host.js";

// Run as a subprocess by the host tests, so an invocation runs under V8 flags the test chose.

interface Invocation {
  readonly request: EnvelopeRequest;
  readonly contribution: InvokedContribution;
  readonly limits: InvocationLimits;
}

const { request, contribution, limits } = JSON.parse(process.argv[3]!) as Invocation;
const host = new InProcessHost();
const loaded = await host.load(process.argv[2]!, "invoke");
const { response } = await host.invoke(loaded, request, contribution, limits);
await host.close();
process.stdout.write(JSON.stringify(response));
