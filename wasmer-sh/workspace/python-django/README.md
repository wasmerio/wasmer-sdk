# Django starter project

A standard `django-admin startproject` project, based on
[Wasmer's python-django example](https://github.com/wasmerio/examples/tree/4b725e357841e2a025760f28db41a04424796b7c/python-django).
It includes `manage.py`, the `mysite` settings and URL configuration, the admin,
and WSGI/ASGI entry points. The home page is Django's default rocket welcome page.

In the browser or iOS shell, install Django and start the development server:

```sh
pip install -r requirements.txt
python manage.py runserver 0.0.0.0:8000 --noreload --nothreading
```

The preview opens automatically on port 8000. Change `8000` to use another port.
Press Ctrl-C to stop the server. `--noreload --nothreading` keeps the server in
one process and handles requests sequentially in the Wasmer sandbox.

To initialize the SQLite database and use Django's admin at `/admin/`:

```sh
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver 0.0.0.0:8000 --noreload --nothreading
```

Enter the admin credentials in the terminal when prompted. Until you run
`migrate`, Django's warning about unapplied migrations is expected; the welcome
page still works. To begin your own app, run `python manage.py startapp hello`,
then register it in `mysite/settings.py` and add its routes to `mysite/urls.py`.

This shell version uses Django 5.2 and SQLite, without the upstream deployment
dependencies for Gunicorn, WhiteNoise, MySQL, or PostgreSQL. Django's staticfiles
app serves static assets during development. Dependencies use the shell's pip
configuration. In debug mode, frame protection is disabled so the shell can
embed the development server; it is restored when `DEBUG=False`.
`DEBUG=True` and the example secret key are development settings;
configure your own secret and production settings before deploying.
