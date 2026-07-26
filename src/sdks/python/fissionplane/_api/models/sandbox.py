from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.sandbox_state import SandboxState
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.egress_policy import EgressPolicy
    from ..models.resources import Resources
    from ..models.sandbox_failure import SandboxFailure
    from ..models.sandbox_metadata import SandboxMetadata


T = TypeVar("T", bound="Sandbox")


@_attrs_define
class Sandbox:
    """
    Attributes:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        state (SandboxState): The tenant-visible states — exactly these four. Transitional
            states are internal: a pausing sandbox reads as `running`, a
            resuming one as `paused`.
        template_artifact_id (str): Immutable lowercase SHA-256 content digest.
        epoch (int): The instance generation. Advances on every resume and
            checkpoint; tokens are minted against an epoch and fail
            closed when it moves.
        domain (str): The sandbox domain suffix. A published port `p` is reachable
            at `https://<p>-<sandbox_id>.<domain>`.
        created_at (datetime.datetime):
        deadline (datetime.datetime): When the lease expires. Recorded here, enforced by the node.
        metadata (SandboxMetadata): Tenant key-value metadata, filterable in list.
        resources (Resources): The compute shape, set by the template artifact.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        failure (SandboxFailure | Unset): Present exactly when `state` is `failed`.
        template (None | str | Unset): The template alias the create named, if it named one.
        restorable_until (datetime.datetime | None | Unset): Paused sandboxes only: the time past which the snapshot is
            no
            longer restorable. The platform refreshes ageing snapshots by
            default; this bound is what a caller sees if it cannot.
        egress (EgressPolicy | Unset): Egress allow and deny lists, fixed at create: policy is part of
            the sandbox's identity, not mutable state a caller can widen
            after the occupant is running. Entries are hostnames or CIDR
            blocks; deny takes precedence.
    """

    sandbox_id: str
    state: SandboxState
    template_artifact_id: str
    epoch: int
    domain: str
    created_at: datetime.datetime
    deadline: datetime.datetime
    metadata: SandboxMetadata
    resources: Resources
    name: str | Unset = UNSET
    failure: SandboxFailure | Unset = UNSET
    template: None | str | Unset = UNSET
    restorable_until: datetime.datetime | None | Unset = UNSET
    egress: EgressPolicy | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sandbox_id = self.sandbox_id

        state = self.state.value

        template_artifact_id = self.template_artifact_id

        epoch = self.epoch

        domain = self.domain

        created_at = self.created_at.isoformat()

        deadline = self.deadline.isoformat()

        metadata = self.metadata.to_dict()

        resources = self.resources.to_dict()

        name = self.name

        failure: dict[str, Any] | Unset = UNSET
        if not isinstance(self.failure, Unset):
            failure = self.failure.to_dict()

        template: None | str | Unset
        if isinstance(self.template, Unset):
            template = UNSET
        else:
            template = self.template

        restorable_until: None | str | Unset
        if isinstance(self.restorable_until, Unset):
            restorable_until = UNSET
        elif isinstance(self.restorable_until, datetime.datetime):
            restorable_until = self.restorable_until.isoformat()
        else:
            restorable_until = self.restorable_until

        egress: dict[str, Any] | Unset = UNSET
        if not isinstance(self.egress, Unset):
            egress = self.egress.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sandbox_id": sandbox_id,
                "state": state,
                "template_artifact_id": template_artifact_id,
                "epoch": epoch,
                "domain": domain,
                "created_at": created_at,
                "deadline": deadline,
                "metadata": metadata,
                "resources": resources,
            }
        )
        if name is not UNSET:
            field_dict["name"] = name
        if failure is not UNSET:
            field_dict["failure"] = failure
        if template is not UNSET:
            field_dict["template"] = template
        if restorable_until is not UNSET:
            field_dict["restorable_until"] = restorable_until
        if egress is not UNSET:
            field_dict["egress"] = egress

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.egress_policy import EgressPolicy
        from ..models.resources import Resources
        from ..models.sandbox_failure import SandboxFailure
        from ..models.sandbox_metadata import SandboxMetadata

        d = dict(src_dict)
        sandbox_id = d.pop("sandbox_id")

        state = SandboxState(d.pop("state"))

        template_artifact_id = d.pop("template_artifact_id")

        epoch = d.pop("epoch")

        domain = d.pop("domain")

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        deadline = datetime.datetime.fromisoformat(d.pop("deadline"))

        metadata = SandboxMetadata.from_dict(d.pop("metadata"))

        resources = Resources.from_dict(d.pop("resources"))

        name = d.pop("name", UNSET)

        _failure = d.pop("failure", UNSET)
        failure: SandboxFailure | Unset
        if isinstance(_failure, Unset):
            failure = UNSET
        else:
            failure = SandboxFailure.from_dict(_failure)

        def _parse_template(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        template = _parse_template(d.pop("template", UNSET))

        def _parse_restorable_until(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                restorable_until_type_0 = datetime.datetime.fromisoformat(data)

                return restorable_until_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        restorable_until = _parse_restorable_until(d.pop("restorable_until", UNSET))

        _egress = d.pop("egress", UNSET)
        egress: EgressPolicy | Unset
        if isinstance(_egress, Unset):
            egress = UNSET
        else:
            egress = EgressPolicy.from_dict(_egress)

        sandbox = cls(
            sandbox_id=sandbox_id,
            state=state,
            template_artifact_id=template_artifact_id,
            epoch=epoch,
            domain=domain,
            created_at=created_at,
            deadline=deadline,
            metadata=metadata,
            resources=resources,
            name=name,
            failure=failure,
            template=template,
            restorable_until=restorable_until,
            egress=egress,
        )

        sandbox.additional_properties = d
        return sandbox

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
