# PHP site

Run PHP's built-in server with this directory as its document root:

```sh
cd /workspace/php && php -S 0.0.0.0:8000 -t .
```

Then edit `index.php` and refresh the preview. Press Ctrl-C to stop the server.
The home page links to `phpinfo.php` for the runtime's complete PHP
configuration.
