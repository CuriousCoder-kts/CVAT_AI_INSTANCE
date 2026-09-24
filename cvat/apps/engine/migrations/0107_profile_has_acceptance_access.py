# Generated manually for Corrections Profile capability flag.

from django.db import migrations, models


def set_has_acceptance_access(apps, schema_editor):
    """Grant Corrections only to username ``admin`` (not every IAM admin)."""
    User = apps.get_model("auth", "User")
    Profile = apps.get_model("engine", "Profile")
    for user in User.objects.filter(username="admin"):
        Profile.objects.filter(user_id=user.id).update(has_acceptance_access=True)


class Migration(migrations.Migration):

    dependencies = [
        ("engine", "0106_add_interval_annotations"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="has_acceptance_access",
            field=models.BooleanField(
                default=False,
                help_text="Designates whether the user can access the Corrections module.",
                verbose_name="has access to Corrections",
            ),
        ),
        migrations.RunPython(
            set_has_acceptance_access,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
