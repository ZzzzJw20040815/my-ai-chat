// A compact stand-in for Gemini groundingMetadata.searchEntryPoint.renderedContent.
// Real chips are a style block plus a container, a link to Google Search, a text label, and an inline SVG.
export const SEARCH_SUGGESTION_SAMPLE = `<style>
.container { width: 100%; }
.chip a { color: #1a0dab; text-decoration: none; }
.outside-only { color: rgb(1, 2, 3); }
</style>
<div class="container">
  <div class="chip">
    <a class="suggestion-link" href="https://www.google.com/search?q=local+qa">
      <span class="suggestion-label">local qa</span>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="#1a0dab" d="M2 2h12v12H2z"></path>
      </svg>
    </a>
  </div>
</div>`;

export const SEARCH_SUGGESTION_ATTACK = `${SEARCH_SUGGESTION_SAMPLE}
<script>alert(1)</script>
<a href="javascript:alert(1)" onclick="alert(2)">bad</a>
<form action="https://evil.example"><input name="q" value="x"></form>
<iframe src="https://evil.example"></iframe>`;
