// Zapier invokes this hook for both build and push, including direct CLI invocations.
if (process.env.HOURMERE_ZAPIER_PUSH_APPROVED !== '1') {
  throw new Error('Build/push requires explicit HOURMERE_ZAPIER_PUSH_APPROVED=1 approval.')
}
