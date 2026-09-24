# Generated for AIFunctionInstance management framework

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("organizations", "0003_bailiansettings"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AIFunctionInstance",
            fields=[
                (
                    "id",
                    models.AutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_date", models.DateTimeField(auto_now_add=True)),
                ("updated_date", models.DateTimeField(auto_now=True)),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ai_function_instances",
                        to="organizations.organization",
                    ),
                ),
                ("slug", models.SlugField(max_length=64)),
                ("name", models.CharField(max_length=128)),
                (
                    "feature_kind",
                    models.CharField(
                        choices=[
                            ("object_detector", "object_detector"),
                            ("intention_estimation", "intention_estimation"),
                            ("image_caption", "image_caption"),
                            ("pose_estimation", "pose_estimation"),
                        ],
                        max_length=32,
                    ),
                ),
                (
                    "provider",
                    models.CharField(
                        choices=[
                            ("bailian", "bailian"),
                            ("local", "local"),
                            ("openai", "openai"),
                            ("custom", "custom"),
                        ],
                        default="bailian",
                        max_length=32,
                    ),
                ),
                ("is_enabled", models.BooleanField(default=True)),
                ("is_default", models.BooleanField(default=False)),
                ("config", models.TextField(blank=True, default=dict)),
                ("nuclio_function_id", models.CharField(blank=True, default="", max_length=256)),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                ("last_used_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "default_permissions": (),
                "unique_together": {("organization", "slug")},
            },
        ),
        migrations.AddIndex(
            model_name="aifunctioninstance",
            index=models.Index(
                fields=["organization", "feature_kind", "is_default"],
                name="organizat_organi_e99d18_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="aifunctioninstance",
            index=models.Index(
                fields=["organization", "is_enabled"],
                name="organizat_organi_85e1d1_idx",
            ),
        ),
    ]
