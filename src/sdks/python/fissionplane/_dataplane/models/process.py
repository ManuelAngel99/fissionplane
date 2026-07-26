from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="Process")


@_attrs_define
class Process:
    """
    Attributes:
        pid (int):
        command (str):
        started_at (datetime.datetime):
        running (bool):
        pty (bool):
        exit_code (int | None | Unset):
        exited_at (datetime.datetime | None | Unset):
    """

    pid: int
    command: str
    started_at: datetime.datetime
    running: bool
    pty: bool
    exit_code: int | None | Unset = UNSET
    exited_at: datetime.datetime | None | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        pid = self.pid

        command = self.command

        started_at = self.started_at.isoformat()

        running = self.running

        pty = self.pty

        exit_code: int | None | Unset
        if isinstance(self.exit_code, Unset):
            exit_code = UNSET
        else:
            exit_code = self.exit_code

        exited_at: None | str | Unset
        if isinstance(self.exited_at, Unset):
            exited_at = UNSET
        elif isinstance(self.exited_at, datetime.datetime):
            exited_at = self.exited_at.isoformat()
        else:
            exited_at = self.exited_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "pid": pid,
                "command": command,
                "started_at": started_at,
                "running": running,
                "pty": pty,
            }
        )
        if exit_code is not UNSET:
            field_dict["exit_code"] = exit_code
        if exited_at is not UNSET:
            field_dict["exited_at"] = exited_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        pid = d.pop("pid")

        command = d.pop("command")

        started_at = datetime.datetime.fromisoformat(d.pop("started_at"))

        running = d.pop("running")

        pty = d.pop("pty")

        def _parse_exit_code(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        exit_code = _parse_exit_code(d.pop("exit_code", UNSET))

        def _parse_exited_at(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                exited_at_type_0 = datetime.datetime.fromisoformat(data)

                return exited_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        exited_at = _parse_exited_at(d.pop("exited_at", UNSET))

        process = cls(
            pid=pid,
            command=command,
            started_at=started_at,
            running=running,
            pty=pty,
            exit_code=exit_code,
            exited_at=exited_at,
        )

        process.additional_properties = d
        return process

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
