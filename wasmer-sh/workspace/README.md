# Wasmer shell workspace

These examples run entirely inside your browser with Wasmer and WASIX.

Selecting an example from the picker puts its files directly in `/workspace`.
The commands below are for the full shell, where all examples have named folders.


| Example             | Start it                                      |
| ------------------- | --------------------------------------------- |
| Node.js HTTP server | `cd node && node server.js`                   |
| Express             | `cd node-express && pnpm i && pnpm run start` |
| Next.js             | `cd next && pnpm i && pnpm dev`               |
| Vinext              | `cd vinext && pnpm i && pnpm dev`             |
| FastAPI             | `cd python-fastapi && pip install -r requirements.txt && python server.py` |
| Flask              | `cd python-flask && pip install -r requirements.txt && python server.py` |
| FFmpeg              | `cd ffmpeg && ffmpeg -n -multiple_requests 1 -i https://cdn.wasmer.io/media/wordpress.mp4 -vf 'fps=10,scale=320:-1' /workspace/ffmpeg/wordpress.gif` |
| yt-dlp              | `cd yt-dlp && pip install -r requirements.txt && /workspace/wasix-packages/bin/yt-dlp --help` |
| Django              | `cd python-django && pip install -r requirements.txt && python manage.py runserver 0.0.0.0:8000 --noreload --nothreading` |
| Python HTTP server  | `cd python && python server.py`               |
| PHP site            | `cd php && php -S 0.0.0.0:8000 -t .`          |


Starting a server opens its site beside the terminal. Press Ctrl-C to stop it
and return to Bash.

Wasmer package data is cached by the browser for faster future starts.
