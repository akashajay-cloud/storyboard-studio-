// Health check — confirms Netlify Functions + the /api/* routing work end to end.
// Reachable at /api/hello (via the redirect in netlify.toml) or /.netlify/functions/hello.
export default async () => {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "Storyboard Studio API",
      step: 1,
      // Lets us confirm the env vars are set WITHOUT ever exposing the keys.
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
      time: new Date().toISOString(),
    }),
    { headers: { "content-type": "application/json" } }
  );
};
