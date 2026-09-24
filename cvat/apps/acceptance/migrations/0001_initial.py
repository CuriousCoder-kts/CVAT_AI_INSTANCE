from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("engine", "0106_add_interval_annotations"),
        ("auth", "0012_alter_user_first_name_max_length"),
    ]

    operations = [
        migrations.CreateModel(
            name="AcceptanceRecord",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_date", models.DateTimeField(auto_now_add=True)),
                ("updated_date", models.DateTimeField(auto_now=True)),
                ("frame", models.PositiveIntegerField()),
                (
                    "action_type",
                    models.CharField(
                        choices=[
                            ("attribute_change", "attribute_change"),
                            ("create", "create"),
                            ("delete", "delete"),
                            ("edit", "edit"),
                            ("label_change", "label_change"),
                            ("move", "move"),
                            ("other", "other"),
                            ("resize", "resize"),
                        ],
                        default="edit",
                        max_length=32,
                    ),
                ),
                ("description", models.TextField(blank=True, default="")),
                (
                    "status",
                    models.CharField(
                        choices=[("draft", "draft"), ("finalized", "finalized")],
                        default="finalized",
                        max_length=32,
                    ),
                ),
                ("shape_count_before", models.PositiveIntegerField(default=0)),
                ("shape_count_after", models.PositiveIntegerField(default=0)),
                ("tag_count_before", models.PositiveIntegerField(default=0)),
                ("tag_count_after", models.PositiveIntegerField(default=0)),
                ("track_count_before", models.PositiveIntegerField(default=0)),
                ("track_count_after", models.PositiveIntegerField(default=0)),
                (
                    "job",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="acceptance_records",
                        related_query_name="acceptance_record",
                        to="engine.job",
                    ),
                ),
                (
                    "reviewer",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="acceptance_records",
                        related_query_name="acceptance_record",
                        to="auth.user",
                    ),
                ),
            ],
            options={
                "default_permissions": (),
            },
        ),
        migrations.CreateModel(
            name="AcceptanceAnnotationSnapshot",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_date", models.DateTimeField(auto_now_add=True)),
                ("updated_date", models.DateTimeField(auto_now=True)),
                (
                    "snapshot_type",
                    models.CharField(
                        choices=[("after", "after"), ("before", "before")],
                        max_length=16,
                    ),
                ),
                ("data", models.JSONField()),
                (
                    "record",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="snapshots",
                        related_query_name="snapshot",
                        to="acceptance.acceptancerecord",
                    ),
                ),
            ],
            options={
                "default_permissions": (),
                "constraints": [
                    models.UniqueConstraint(
                        fields=["record", "snapshot_type"],
                        name="unique_snapshot_per_record_per_type",
                    ),
                ],
            },
        ),
        migrations.AddIndex(
            model_name="acceptancerecord",
            index=models.Index(fields=["job", "frame"], name="acceptance__job_fra_a33d48_idx"),
        ),
        migrations.AddIndex(
            model_name="acceptancerecord",
            index=models.Index(fields=["reviewer"], name="acceptance__reviewe_6dd9e8_idx"),
        ),
        migrations.AddIndex(
            model_name="acceptancerecord",
            index=models.Index(fields=["created_date"], name="acceptance__created_702233_idx"),
        ),
    ]
