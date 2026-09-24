# Data migration: copy existing BailianSettings to default AIFunctionInstance records

from django.db import migrations


def migrate_bailian_settings_forward(apps, schema_editor):
    from cvat.apps.organizations.models import (
        AIFunctionInstance,
        BailianSettings,
        FeatureKind,
        ProviderKind,
    )

    qs = BailianSettings.objects.select_related("organization").all()
    created_count = 0
    skipped_count = 0

    for bs in qs.iterator():
        has_any = bool(bs.api_key or bs.api_url or bs.model)
        if not has_any:
            skipped_count += 1
            continue

        slug = "bailian-default-detector"
        exists = AIFunctionInstance.objects.filter(
            organization_id=bs.organization_id, slug=slug
        ).exists()
        if exists:
            skipped_count += 1
            continue

        try:
            AIFunctionInstance.objects.create(
                organization_id=bs.organization_id,
                slug=slug,
                name="Bailian Default Detector (migrated)",
                feature_kind=FeatureKind.OBJECT_DETECTOR,
                provider=ProviderKind.BAILIAN,
                is_enabled=True,
                is_default=True,
                config={
                    "api_key": bs.api_key or "",
                    "api_url": bs.api_url or "",
                    "model": bs.model or "",
                },
                nuclio_function_id="",
                updated_by_id=bs.updated_by_id,
            )
            created_count += 1
        except Exception:
            skipped_count += 1

    print(
        f"[0005] migrate_bailian_settings: created={created_count}, skipped={skipped_count}"
    )


def migrate_bailian_settings_backward(apps, schema_editor):
    from cvat.apps.organizations.models import AIFunctionInstance, FeatureKind

    deleted, _ = (
        AIFunctionInstance.objects.filter(
            feature_kind=FeatureKind.OBJECT_DETECTOR,
            slug="bailian-default-detector",
        ).delete()
    )
    print(f"[0005] rollback: deleted {deleted} AIFunctionInstance records")


class Migration(migrations.Migration):
    dependencies = [
        ("organizations", "0004_aifunctioninstance"),
    ]

    operations = [
        migrations.RunPython(
            migrate_bailian_settings_forward,
            migrate_bailian_settings_backward,
        ),
    ]
