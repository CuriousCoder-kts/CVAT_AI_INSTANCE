# Copyright (C) 2021-2022 Intel Corporation
# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import secrets
import string

from attr.converters import to_bool
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.exceptions import ObjectDoesNotExist, ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers

from cvat.apps.engine.serializers import BasicUserSerializer
from cvat.apps.iam.password_validation import (
    DEFAULT_MAX_PASSWORD_LENGTH,
    DEFAULT_MIN_PASSWORD_LENGTH,
)
from cvat.apps.iam.utils import get_dummy_or_regular_user

from .models import (
    AIFunctionInstance,
    BailianSettings,
    EncryptedJSONField,
    Invitation,
    Membership,
    Organization,
)


def _generate_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(max(length, DEFAULT_MIN_PASSWORD_LENGTH)))
        if (
            any(c.islower() for c in password)
            and any(c.isupper() for c in password)
            and any(c.isdigit() for c in password)
        ):
            break
    return password[: min(len(password), DEFAULT_MAX_PASSWORD_LENGTH)]


class OrganizationReadSerializer(serializers.ModelSerializer):
    owner = BasicUserSerializer(allow_null=True)

    class Meta:
        model = Organization
        fields = [
            "id",
            "slug",
            "name",
            "description",
            "created_date",
            "updated_date",
            "contact",
            "owner",
        ]
        read_only_fields = fields


class BasicOrganizationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Organization
        fields = ["id", "slug"]
        read_only_fields = fields


class OrganizationWriteSerializer(serializers.ModelSerializer):
    def to_representation(self, instance):
        serializer = OrganizationReadSerializer(instance, context=self.context)
        return serializer.data

    class Meta:
        model = Organization
        fields = ["slug", "name", "description", "contact", "owner"]

        # TODO: at the moment isn't possible to change the owner. It should
        # be a separate feature. Need to change it together with corresponding
        # Membership. Also such operation should be well protected.
        read_only_fields = ["owner"]

    def create(self, validated_data):
        organization = super().create(validated_data)
        Membership.objects.create(
            user=organization.owner,
            organization=organization,
            is_active=True,
            joined_date=organization.created_date,
            role=Membership.OWNER,
        )

        return organization


class InvitationReadSerializer(serializers.ModelSerializer):
    role = serializers.ChoiceField(Membership.role.field.choices, source="membership.role")
    user = BasicUserSerializer(source="membership.user")
    organization = serializers.PrimaryKeyRelatedField(
        queryset=Organization.objects.all(), source="membership.organization"
    )
    organization_info = BasicOrganizationSerializer(source="membership.organization")
    owner = BasicUserSerializer(allow_null=True)

    class Meta:
        model = Invitation
        fields = [
            "key",
            "created_date",
            "owner",
            "role",
            "user",
            "organization",
            "expired",
            "accepted",
            "organization_info",
        ]
        read_only_fields = fields
        extra_kwargs = {
            "expired": {
                "allow_null": True,
            }
        }


class InvitationWriteSerializer(serializers.ModelSerializer):
    role = serializers.ChoiceField(Membership.role.field.choices, source="membership.role")
    email = serializers.EmailField(source="membership.user.email")
    organization = serializers.PrimaryKeyRelatedField(
        source="membership.organization", read_only=True
    )

    def to_representation(self, instance):
        serializer = InvitationReadSerializer(instance, context=self.context)
        return serializer.data

    class Meta:
        model = Invitation
        fields = ["key", "created_date", "owner", "role", "organization", "email"]
        read_only_fields = ["key", "created_date", "owner", "organization"]

    @transaction.atomic
    def create(self, validated_data):
        membership_data = validated_data.pop("membership")
        organization = validated_data.pop("organization")
        try:
            user = get_user_model().objects.get(email__iexact=membership_data["user"]["email"])
            del membership_data["user"]
        except ObjectDoesNotExist:
            user_email = membership_data["user"]["email"]
            user = User.objects.create_user(username=user_email, email=user_email)
            user.set_unusable_password()
            user.save()
            del membership_data["user"]
        membership, created = Membership.objects.get_or_create(
            defaults=membership_data, user=user, organization=organization
        )
        if not created:
            raise serializers.ValidationError(
                "The user is a member of " "the organization already."
            )
        invitation = Invitation.objects.create(**validated_data, membership=membership)

        return invitation

    def save(self, request, **kwargs):
        invitation = super().save(**kwargs)
        _, regular_user = get_dummy_or_regular_user(invitation.membership.user.email)
        if not to_bool(settings.ORG_INVITATION_CONFIRM) and regular_user:
            invitation.accept()
        else:
            invitation.send(request)

        return invitation


class MembershipReadSerializer(serializers.ModelSerializer):
    user = BasicUserSerializer()

    class Meta:
        model = Membership
        fields = ["id", "user", "organization", "is_active", "joined_date", "role", "invitation"]
        read_only_fields = fields
        extra_kwargs = {
            "invitation": {
                "allow_null": True,  # owner of an organization does not have an invitation
            }
        }


class MembershipWriteSerializer(serializers.ModelSerializer):
    def to_representation(self, instance):
        serializer = MembershipReadSerializer(instance, context=self.context)
        return serializer.data

    class Meta:
        model = Membership
        fields = ["id", "user", "organization", "is_active", "joined_date", "role"]
        read_only_fields = ["user", "organization", "is_active", "joined_date"]


class AcceptInvitationReadSerializer(serializers.Serializer):
    organization_slug = serializers.CharField()


class BailianSettingsReadSerializer(serializers.ModelSerializer):
    updated_by = BasicUserSerializer(allow_null=True)
    has_api_key = serializers.SerializerMethodField()

    class Meta:
        model = BailianSettings
        fields = ["api_url", "model", "has_api_key", "updated_date", "updated_by"]
        read_only_fields = fields

    def get_has_api_key(self, obj: BailianSettings) -> bool:
        return bool(obj.api_key)


class BailianSettingsWriteSerializer(serializers.ModelSerializer):
    api_key = serializers.CharField(
        required=False,
        allow_null=True,
        allow_blank=True,
        write_only=True,
    )

    def to_representation(self, instance):
        serializer = BailianSettingsReadSerializer(instance, context=self.context)
        return serializer.data

    class Meta:
        model = BailianSettings
        fields = ["api_url", "model", "api_key"]

    def update(self, instance, validated_data):
        if "api_key" in validated_data and validated_data["api_key"] is None:
            validated_data["api_key"] = ""
        return super().update(instance, validated_data)


def _redact_config(config: dict) -> tuple[dict, dict]:
    public = {}
    presence = {}
    if not isinstance(config, dict):
        return {}, {}
    for k, v in config.items():
        k_lower = k.lower()
        is_sensitive = any(
            substr in k_lower
            for substr in EncryptedJSONField.SENSITIVE_KEY_SUBSTRINGS
        )
        if is_sensitive:
            presence[f"has_{k}"] = bool(v)
        else:
            public[k] = v
    return public, presence


class AIFunctionInstanceReadSerializer(serializers.ModelSerializer):
    updated_by = BasicUserSerializer(allow_null=True)
    config = serializers.SerializerMethodField()
    has_sensitive_config = serializers.SerializerMethodField()

    class Meta:
        model = AIFunctionInstance
        fields = [
            "id",
            "slug",
            "name",
            "feature_kind",
            "provider",
            "is_enabled",
            "is_default",
            "config",
            "has_sensitive_config",
            "nuclio_function_id",
            "created_date",
            "updated_date",
            "updated_by",
            "last_used_at",
        ]
        read_only_fields = fields

    def get_config(self, obj: AIFunctionInstance) -> dict:
        public, _ = _redact_config(obj.config)
        return public

    def get_has_sensitive_config(self, obj: AIFunctionInstance) -> dict:
        _, presence = _redact_config(obj.config)
        return presence


class AIFunctionInstanceWriteSerializer(serializers.ModelSerializer):
    slug = serializers.RegexField(
        regex=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
        max_length=64,
        required=True,
        error_messages={
            "invalid": "Slug must start with alphanumeric and contain only [a-zA-Z0-9_-]",
        },
    )
    name = serializers.CharField(max_length=128, required=True, allow_blank=False)
    feature_kind = serializers.ChoiceField(
        choices=AIFunctionInstance.feature_kind.field.choices, required=True
    )
    provider = serializers.ChoiceField(
        choices=AIFunctionInstance.provider.field.choices,
        required=False,
        default=AIFunctionInstance.provider.field.default,
    )
    is_enabled = serializers.BooleanField(required=False, default=True)
    is_default = serializers.BooleanField(required=False, default=False)
    config = serializers.JSONField(required=False, default=dict)
    nuclio_function_id = serializers.CharField(
        max_length=256, required=False, allow_blank=True
    )

    def to_representation(self, instance):
        serializer = AIFunctionInstanceReadSerializer(instance, context=self.context)
        return serializer.data

    class Meta:
        model = AIFunctionInstance
        fields = [
            "slug",
            "name",
            "feature_kind",
            "provider",
            "is_enabled",
            "is_default",
            "config",
            "nuclio_function_id",
        ]

    def validate_config(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("config must be a JSON object")
        for k, v in value.items():
            if not isinstance(k, str):
                raise serializers.ValidationError("config keys must be strings")
            if not isinstance(v, (str, int, float, bool, list, dict, type(None))):
                raise serializers.ValidationError(
                    f"config value for '{k}' has unsupported type {type(v).__name__}"
                )
            if k == "labels" and isinstance(v, list):
                for idx, label in enumerate(v):
                    if not isinstance(label, dict):
                        raise serializers.ValidationError(
                            f"config.labels[{idx}] must be a JSON object"
                        )
                    if not isinstance(label.get("name"), str) or not label["name"]:
                        raise serializers.ValidationError(
                            f"config.labels[{idx}] must have a non-empty string 'name'"
                        )
                    if "type" in label and label["type"] is not None:
                        valid_types = {
                            "any", "rectangle", "polygon", "polyline", "points", "ellipse",
                            "circle", "mask", "cuboid", "skeleton", "tag",
                        }
                        if str(label["type"]).lower() not in valid_types:
                            raise serializers.ValidationError(
                                f"config.labels[{idx}].type must be one of {sorted(valid_types)}"
                            )
            # ====================================================================
            # Prompt-driven skill extensions (v0: VLM prompt + output parser config)
            # ====================================================================
            if k == "execution_mode" and v is not None:
                if str(v) not in {"vlm_prompt", "vision_pipeline", "hybrid_agent"}:
                    raise serializers.ValidationError(
                        "config.execution_mode must be one of: "
                        "vlm_prompt / vision_pipeline / hybrid_agent"
                    )
            if k == "system_prompt_template" and v is not None:
                if not isinstance(v, str):
                    raise serializers.ValidationError(
                        "config.system_prompt_template must be a string"
                    )
                if len(v) > 200000:
                    raise serializers.ValidationError(
                        "config.system_prompt_template exceeds 200000 chars"
                    )
            if k == "user_prompt_template" and v is not None:
                if not isinstance(v, str):
                    raise serializers.ValidationError(
                        "config.user_prompt_template must be a string"
                    )
                if len(v) > 50000:
                    raise serializers.ValidationError(
                        "config.user_prompt_template exceeds 50000 chars"
                    )
            if k == "prompt_variables" and v is not None:
                if not isinstance(v, list):
                    raise serializers.ValidationError(
                        "config.prompt_variables must be a list"
                    )
                for vi, pv in enumerate(v):
                    if not isinstance(pv, dict):
                        raise serializers.ValidationError(
                            f"config.prompt_variables[{vi}] must be a dict "
                            "{{key, label?, type?, default?, required?}}"
                        )
                    if not isinstance(pv.get("key"), str) or not pv["key"]:
                        raise serializers.ValidationError(
                            f"config.prompt_variables[{vi}] requires non-empty string 'key'"
                        )
                    import re as _re_local
                    if not _re_local.match(r"^[A-Za-z_][A-Za-z0-9_]*$", pv["key"]):
                        raise serializers.ValidationError(
                            f"config.prompt_variables[{vi}].key must match "
                            r"regex ^[A-Za-z_][A-Za-z0-9_]*$ (identifier-like)"
                        )
                    if "type" in pv and pv["type"] is not None:
                        if str(pv["type"]) not in {"text", "textarea", "number", "select", "bool"}:
                            raise serializers.ValidationError(
                                f"config.prompt_variables[{vi}].type must be one of "
                                "text/textarea/number/select/bool"
                            )
                    if "required" in pv and pv["required"] is not None and not isinstance(pv["required"], bool):
                        raise serializers.ValidationError(
                            f"config.prompt_variables[{vi}].required must be bool"
                        )
            if k == "output_format" and v is not None:
                # Keep registry extensible: unknown formats allowed (will fall back to
                # rectangles parser at runtime). Whitelist here purely for early UX help.
                if not isinstance(v, str) or not v:
                    raise serializers.ValidationError(
                        "config.output_format must be a non-empty string "
                        "(e.g. rectangles / polygons / captions)"
                    )
            if k == "output_parser_config" and v is not None:
                if not isinstance(v, dict):
                    raise serializers.ValidationError(
                        "config.output_parser_config must be a dict"
                    )
                for pck, pcv in v.items():
                    if pck in {
                        "confidence_threshold_default",
                        "iou_threshold_nms",
                        "iou_threshold_recall_merge",
                        "canonical_box_min_span",
                        "global_area_min_px",
                        "global_ratio_min",
                        "global_ratio_max",
                        "global_area_ratio_max_per_image",
                        "recall_second_call_min_total_pixels",
                        "vlm_call_timeout_seconds",
                    }:
                        if pcv is not None and not isinstance(pcv, (int, float)):
                            raise serializers.ValidationError(
                                f"config.output_parser_config.{pck} must be a number"
                            )
                    elif pck == "coordinate_system":
                        if pcv is not None and str(pcv) not in {
                            "canonical_1000", "real_pixel", "normalized_0_1",
                        }:
                            raise serializers.ValidationError(
                                "config.output_parser_config.coordinate_system must be one of "
                                "canonical_1000 / real_pixel / normalized_0_1"
                            )
                    elif pck == "per_label_min_area_px_soft":
                        if not isinstance(pcv, dict):
                            raise serializers.ValidationError(
                                "config.output_parser_config.per_label_min_area_px_soft "
                                "must be {label_name: min_px_int}"
                            )
                        for lbl_name, lbl_val in pcv.items():
                            if not isinstance(lbl_name, str) or not isinstance(lbl_val, int):
                                raise serializers.ValidationError(
                                    "config.output_parser_config.per_label_min_area_px_soft "
                                    "values must be {string_label: int_px}"
                                )
                    elif pck == "label_specific_rules":
                        if not isinstance(pcv, dict):
                            raise serializers.ValidationError(
                                "config.output_parser_config.label_specific_rules must be a dict "
                                "keyed by label name"
                            )
                    elif pck == "ped_cyclist_merge_enabled":
                        if pcv is not None and not isinstance(pcv, bool):
                            raise serializers.ValidationError(
                                "output_parser_config.ped_cyclist_merge_enabled must be bool"
                            )
                    elif pck == "ped_cyclist_merge_params":
                        if not isinstance(pcv, dict):
                            raise serializers.ValidationError(
                                "output_parser_config.ped_cyclist_merge_params must be dict"
                            )
                    elif pck == "recall_second_call_enabled":
                        if pcv is not None and not isinstance(pcv, bool):
                            raise serializers.ValidationError(
                                "output_parser_config.recall_second_call_enabled must be bool"
                            )
                    elif pck == "caption_attribute_name":
                        if pcv is not None and (not isinstance(pcv, str) or not pcv):
                            raise serializers.ValidationError(
                                "output_parser_config.caption_attribute_name must be a "
                                "non-empty string"
                            )
                    elif pck == "quality_gate":
                        if not isinstance(pcv, dict):
                            raise serializers.ValidationError(
                                "output_parser_config.quality_gate must be dict "
                                "{low_confidence_threshold: float, multi_worker_consensus: bool}"
                            )
                    # Unknown parser keys are silently accepted (forward-compatible for
                    # future parsers — we don't block user innovation at API level).
            if k == "pipeline_nodes" and v is not None:
                if not isinstance(v, list):
                    raise serializers.ValidationError(
                        "config.pipeline_nodes must be a list (future vision_pipeline mode)"
                    )
            if k == "preset_id" and v is not None:
                if not isinstance(v, str) or not v:
                    raise serializers.ValidationError(
                        "config.preset_id must be a non-empty string when provided"
                    )
        return value

    def validate_slug(self, value):
        import re
        if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$", value):
            raise serializers.ValidationError(
                "Slug must start with an alphanumeric character and contain only "
                "[a-zA-Z0-9_-] characters."
            )
        return value

    def create(self, validated_data):
        from django.db import IntegrityError

        organization = self.context["organization"]
        slug = validated_data.get("slug")
        if slug is not None and (
            type(self).Meta.model.objects.filter(
                organization=organization, slug=slug
            ).exists()
        ):
            raise serializers.ValidationError(
                {
                    "slug": (
                        f"An AI function instance with slug '{slug}' already exists "
                        f"in this organization."
                    )
                },
                code="unique_slug_conflict",
            )
        validated_data["organization"] = organization
        validated_data["updated_by"] = self.context.get("updated_by")
        try:
            return super().create(validated_data)
        except IntegrityError as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise serializers.ValidationError(
                    {"slug": "Slug already exists in this organization."},
                    code="unique_slug_conflict",
                ) from exc
            raise

    def update(self, instance, validated_data):
        from django.db import IntegrityError

        validated_data.pop("organization", None)
        validated_data["updated_by"] = self.context.get("updated_by")

        new_slug = validated_data.get("slug")
        organization = self.context["organization"]
        if new_slug and new_slug != instance.slug and (
            type(self).Meta.model.objects.filter(
                organization=organization, slug=new_slug
            ).exclude(pk=instance.pk).exists()
        ):
            raise serializers.ValidationError(
                {"slug": f"Slug '{new_slug}' already exists in this organization."},
                code="unique_slug_conflict",
            )

        incoming_config = validated_data.get("config")
        if isinstance(incoming_config, dict):
            merged_config = dict(instance.config) if instance.config else {}
            for k, v in incoming_config.items():
                if v is None:
                    merged_config.pop(k, None)
                else:
                    merged_config[k] = v
            validated_data["config"] = merged_config
        try:
            return super().update(instance, validated_data)
        except IntegrityError as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise serializers.ValidationError(
                    {"slug": "Slug already exists in this organization."},
                    code="unique_slug_conflict",
                ) from exc
            raise


class CreateMemberItemSerializer(serializers.Serializer):
    username = serializers.CharField(
        max_length=User._meta.get_field("username").max_length, required=True)
    email = serializers.EmailField(required=True)
    first_name = serializers.CharField(
        max_length=User._meta.get_field("first_name").max_length, required=False, allow_blank=True
    )
    last_name = serializers.CharField(
        max_length=User._meta.get_field("last_name").max_length, required=False, allow_blank=True
    )
    password = serializers.CharField(
        required=False,
        allow_blank=True,
        write_only=True,
        trim_whitespace=False,
        min_length=DEFAULT_MIN_PASSWORD_LENGTH,
        max_length=DEFAULT_MAX_PASSWORD_LENGTH,
    )
    role = serializers.ChoiceField(
        choices=[(k, v) for k, v in Membership.role.field.choices if k != Membership.OWNER],
        default=Membership.WORKER,
    )


class CreateMemberResultSerializer(serializers.Serializer):
    username = serializers.CharField()
    email = serializers.EmailField()
    first_name = serializers.CharField()
    last_name = serializers.CharField()
    role = serializers.CharField()
    password = serializers.CharField()
    user_id = serializers.IntegerField()
    membership_id = serializers.IntegerField()


class CreateMembersRequestSerializer(serializers.Serializer):
    members = serializers.ListField(
        child=CreateMemberItemSerializer(),
        allow_empty=False,
    )

    def validate_members(self, value):
        if not value:
            raise serializers.ValidationError("At least one member must be provided.")
        if len(value) > 100:
            raise serializers.ValidationError("Maximum 100 members can be created at once.")
        return value

    @transaction.atomic
    def create_members(self, organization: Organization, request):
        results = []
        errors = []
        UserModel = get_user_model()

        for idx, item in enumerate(self.validated_data["members"]):
            try:
                username = item["username"].strip()
                email = item["email"].strip()
                first_name = item.get("first_name", "").strip()
                last_name = item.get("last_name", "").strip()
                password = item.get("password", "").strip() or _generate_password()
                role = item.get("role", Membership.WORKER)

                if UserModel.objects.filter(username__iexact=username).exists():
                    raise serializers.ValidationError(f"Username '{username}' already exists.")
                if UserModel.objects.filter(email__iexact=email).exists():
                    raise serializers.ValidationError(f"Email '{email}' already registered.")
                if Membership.objects.filter(
                    user__email__iexact=email, organization=organization
                ).exists() or Membership.objects.filter(
                    user__username__iexact=username, organization=organization
                ).exists():
                    raise serializers.ValidationError(
                        f"User '{username}/{email}' is already a member of the organization."
                    )

                user = UserModel.objects.create_user(
                    username=username,
                    email=email,
                    first_name=first_name,
                    last_name=last_name,
                    password=password,
                )
                user.is_active = True
                user.save()

                from allauth.account.models import EmailAddress
                EmailAddress.objects.create(
                    user=user, email=email, verified=True, primary=True
                )

                membership = Membership.objects.create(
                    user=user,
                    organization=organization,
                    is_active=True,
                    role=role,
                )

                results.append({
                    "username": user.username,
                    "email": user.email,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "role": role,
                    "password": password,
                    "user_id": user.id,
                    "membership_id": membership.id,
                })
            except serializers.ValidationError as e:
                errors.append({"index": idx, "username": item.get("username"), "error": str(e.detail) if hasattr(e, 'detail') else str(e)})
            except DjangoValidationError as e:
                errors.append({"index": idx, "username": item.get("username"), "error": str(e)})
            except Exception as e:
                errors.append({"index": idx, "username": item.get("username"), "error": str(e)})

        return results, errors
