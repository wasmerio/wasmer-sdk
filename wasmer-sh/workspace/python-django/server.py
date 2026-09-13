import os

import django
from django.conf import settings
from django.core.management import call_command
from django.http import HttpResponse, JsonResponse
from django.template import engines
from django.urls import path

settings.configure(
    DEBUG=True,
    SECRET_KEY="browser-demo-only",
    ALLOWED_HOSTS=["localhost", "127.0.0.1", "[::1]"],
    ROOT_URLCONF=__name__,
    MIDDLEWARE=["django.middleware.common.CommonMiddleware"],
    INSTALLED_APPS=[],
    TEMPLATES=[{"BACKEND": "django.template.backends.django.DjangoTemplates"}],
    USE_TZ=True,
)
django.setup()

PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Django on Wasmer</title>
  <style>
    body { font: 18px system-ui; max-width: 720px; margin: 10vh auto; padding: 0 24px; color: #20172b; }
    input, button { font: inherit; padding: 8px 12px; }
    li { margin: 12px 0; }
    pre { white-space: pre-wrap; background: #f4f0fa; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Django is running in your browser</h1>
  <p>This page was rendered by Django {{ version }} inside WASIX.</p>
  <form id="greeting">
    <label for="name">Your name</label>
    <input id="name" name="name" value="Browser" maxlength="80" required>
    <button>Say hello</button>
  </form>
  <pre id="result">Checking API...</pre>
  <ul id="checks"><li>Running checks...</li></ul>
  <script>
    async function greet() {
      const response = await fetch('/api/hello?name=' + encodeURIComponent(document.querySelector('#name').value));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Greeting failed');
      document.querySelector('#result').textContent = JSON.stringify(data, null, 2);
      return data;
    }
    document.querySelector('#greeting').addEventListener('submit', event => {
      event.preventDefault();
      greet().catch(error => { document.querySelector('#result').textContent = error.message; });
    });
    async function verify() {
      const response = await fetch('/health');
      const health = await response.json();
      const greeting = await greet();
      const invalid = await fetch('/api/hello?name=');
      const checks = [
        response.ok && health.ok === true ? 'PASS: GET /health' : 'FAIL: GET /health',
        greeting.message === 'Hello, Browser!' ? 'PASS: Django greeting endpoint' : 'FAIL: Greeting endpoint',
        invalid.status === 400 ? 'PASS: Empty name returns HTTP 400' : 'FAIL: Empty name accepted'
      ];
      document.querySelector('#checks').replaceChildren(...checks.map(text => {
        const li = document.createElement('li'); li.textContent = text; return li;
      }));
    }
    verify().catch(error => { document.querySelector('#checks').textContent = 'FAIL: ' + error.message; });
  </script>
</body>
</html>"""


def index(request):
    template = engines["django"].from_string(PAGE)
    return HttpResponse(template.render({"version": django.get_version()}, request))


def health(request):
    return JsonResponse({"ok": True, "framework": "django"})


def hello(request):
    name = request.GET.get("name", "Browser").strip()
    if not name or len(name) > 80:
        return JsonResponse({"error": "Name must contain 1 to 80 characters."}, status=400)
    return JsonResponse({"message": f"Hello, {name}!"})


urlpatterns = [
    path("", index),
    path("health", health),
    path("api/hello", hello),
]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    call_command("runserver", f"0.0.0.0:{port}", use_reloader=False, use_threading=False)
