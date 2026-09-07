const launchMessages = [
  { role: 'user', text: 'I’m preparing to launch a small productivity app. Can you give me a focused two-week launch plan?' },
  { role: 'assistant', html: `
    <p>Absolutely. Here’s a compact plan designed to move from “nearly ready” to a confident launch without creating unnecessary work.</p>
    <h3>Week 1 — Clarify and prepare</h3>
    <ul><li>Define one primary user and the single problem the app solves best.</li><li>Polish the onboarding path and remove any blockers before the first useful result.</li><li>Create a short landing page, three product screenshots, and one demo clip.</li></ul>
    <h3>Week 2 — Release and learn</h3>
    <ul><li>Invite a small group of early users and watch where they hesitate.</li><li>Fix only launch-blocking issues; keep nice-to-have ideas in a separate list.</li><li>Publish the launch, then review activation and feedback after 48 hours.</li></ul>
    <p>A simple event structure could look like this:</p>
    <div class="code-block"><div class="code-head"><span>javascript</span><button data-code-copy>Copy code</button></div><pre><code><span class="token-key">const</span> launchEvents = [
  <span class="token-string">'signup_started'</span>,
  <span class="token-string">'first_value_reached'</span>,
  <span class="token-string">'feedback_sent'</span>
];
<span class="token-key">const</span> analyticsEndpoint = <span class="token-string">'https://example.com/v1/product-launch/analytics/events/first-meaningful-outcome'</span>;</code></pre></div>
    <p>The most important metric for this first launch is not traffic—it’s how many new users reach the app’s first meaningful outcome.</p>` },
  { role: 'user', text: 'That helps. What should I avoid during those two weeks?' },
  { role: 'assistant', html: `<p>Avoid expanding the product at the moment you need clarity most. In particular:</p><ul><li>Don’t add features just because launch makes the product feel exposed.</li><li>Don’t split attention across every social channel.</li><li>Don’t wait for perfect copy or visuals before talking to real users.</li><li>Don’t treat all feedback equally—look for repeated friction tied to the core workflow.</li></ul><p>Keep the launch narrow, measurable, and easy to learn from.</p>` }
];

export const demoData = {
  launch: { title: 'Plan a product launch', subtitle: 'Today · Gemini 3 Pro', messages: launchMessages },
  react: { title: 'Explain React state', subtitle: 'Today · Gemini 3 Pro', messages: [
    { role: 'user', text: 'Explain React state to me with a simple mental model.' },
    { role: 'assistant', html: '<p>Think of state as a component’s memory. Props are information handed to it; state is information it remembers and can update. When that memory changes, React redraws the relevant interface so it matches the new value.</p><div class="code-block"><div class="code-head"><span>jsx</span><button data-code-copy>Copy code</button></div><pre><code><span class="token-key">const</span> [count, setCount] = <span class="token-fn">useState</span>(0);</code></pre></div>' }
  ]},
  email: { title: 'Improve a client email', subtitle: 'Today · Gemini 3 Pro', messages: [
    { role: 'user', text: 'Make this client follow-up warmer while keeping it concise.' },
    { role: 'assistant', html: '<p>Of course—paste the draft here and I’ll keep the message direct, warm, and natural.</p>' }
  ]},
  travel: { title: 'Singapore weekend plan', subtitle: 'Yesterday · Gemini 3 Pro', messages: [
    { role: 'user', text: 'Help me shape a relaxed weekend in Singapore.' },
    { role: 'assistant', html: '<p>I’d keep it intentionally light: one neighborhood in the morning, a long lunch, and a flexible evening. That leaves space for weather, energy, and discoveries along the way.</p>' }
  ]},
  python: { title: 'Python data cleanup', subtitle: 'Yesterday · Gemini 3 Pro', messages: [
    { role: 'user', text: 'What is a safe order for cleaning a CSV dataset?' },
    { role: 'assistant', html: '<p>Start by preserving the raw file. Then inspect types and missing values, normalize formats, resolve duplicates, validate ranges, and export to a new file with a short change log.</p>' }
  ]},
  notes: { title: 'Summarize meeting notes', subtitle: 'Yesterday · Gemini 3 Pro', messages: [
    { role: 'user', text: 'Turn my meeting notes into decisions and next actions.' },
    { role: 'assistant', html: '<p>Attach or paste the notes. I’ll separate confirmed decisions, open questions, owners, and next actions so the result is easy to scan.</p>' }
  ]}
};


